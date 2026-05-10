// routes/admin.js
const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcryptjs');
const db           = require('../database/db');
const autenticarJWT = require('../middleware/auth');

// ─── Importa o bot oficial para envio de mensagens ───────────
const { botOficial } = require('./whatsapp-oficial');

// ─── Middleware 1: token estático via env (rotas do bot) ──────
function autenticarToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  next();
}

// ─── Middleware 2: JWT Bearer + verifica e-mail admin ─────────
const ADMIN_EMAIL = 'matheus10201971@gmail.com';

function autenticarAdmin(req, res, next) {
  autenticarJWT(req, res, () => {
    if (req.usuarioEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ erro: 'Acesso restrito ao administrador' });
    }
    next();
  });
}

// ══════════════════════════════════════════════════════════════
//  ROTAS DO BOT OFICIAL — status e envio via Meta API
// ══════════════════════════════════════════════════════════════

// ─── GET /api/admin/status ────────────────────────────────────
router.get('/status', autenticarToken, (req, res) => {
  res.json({
    conectado: true,
    tipo: 'whatsapp-oficial',
    phone_id: process.env.WA_OFICIAL_PHONE_ID || null,
  });
});

// ══════════════════════════════════════════════════════════════
//  ROTAS DE ADMINISTRAÇÃO — protegidas por JWT + e-mail admin
// ══════════════════════════════════════════════════════════════

// ─── GET /api/admin/users ─────────────────────────────────────
router.get('/users', autenticarAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id,
        u.nome,
        u.sobrenome,
        u.email,
        u.telefone,
        u.plano,
        u.whatsapp_ativo,
        u.stripe_customer_id,
        u.stripe_subscription_id,
        u.criado_em,
        u.atualizado_em,
        (SELECT COUNT(*) FROM transacoes t WHERE t.usuario_id = u.id)::int  AS total_transacoes,
        (SELECT COALESCE(SUM(t.valor), 0)
           FROM transacoes t
           WHERE t.usuario_id = u.id AND t.tipo = 'receita')::numeric       AS total_receitas,
        (SELECT COALESCE(SUM(t.valor), 0)
           FROM transacoes t
           WHERE t.usuario_id = u.id AND t.tipo = 'despesa')::numeric       AS total_despesas
      FROM usuarios u
      ORDER BY u.criado_em DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ admin/users GET:', err);
    res.status(500).json({ erro: 'Erro interno ao listar usuários' });
  }
});

// ─── POST /api/admin/users ────────────────────────────────────
router.post('/users', autenticarAdmin, async (req, res) => {
  const { nome, sobrenome, email, senha, telefone, plano } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  try {
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    const senha_hash = await bcrypt.hash(senha, 12);
    const { rows } = await db.query(
      `INSERT INTO usuarios (nome, sobrenome, email, senha_hash, telefone, plano)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, sobrenome, email, telefone, plano, criado_em`,
      [
        nome.trim(),
        sobrenome?.trim() || null,
        email.toLowerCase().trim(),
        senha_hash,
        telefone?.replace(/\D/g, '') || null,
        plano || 'gratuito'
      ]
    );

    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo) VALUES ($1, 'Carteira', true, 0)`,
      [rows[0].id]
    );

    res.status(201).json({ ok: true, usuario: rows[0] });
  } catch (err) {
    console.error('❌ admin/users POST:', err);
    res.status(500).json({ erro: 'Erro interno ao criar usuário' });
  }
});

// ─── PUT /api/admin/users/:id ─────────────────────────────────
router.put('/users/:id', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  const { nome, sobrenome, telefone, plano, senha } = req.body;

  if (!nome)
    return res.status(400).json({ erro: 'Nome é obrigatório' });

  try {
    const existe = await db.query('SELECT id FROM usuarios WHERE id = $1', [id]);
    if (!existe.rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    await db.query(
      `UPDATE usuarios
       SET nome = $1, sobrenome = $2, telefone = $3, plano = $4, atualizado_em = NOW()
       WHERE id = $5`,
      [
        nome.trim(),
        sobrenome?.trim() || null,
        telefone?.replace(/\D/g, '') || null,
        plano || 'gratuito',
        id
      ]
    );

    if (senha && senha.length >= 6) {
      const senha_hash = await bcrypt.hash(senha, 12);
      await db.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [senha_hash, id]);
    }

    const { rows } = await db.query(
      `SELECT id, nome, sobrenome, email, telefone, plano, criado_em, atualizado_em
       FROM usuarios WHERE id = $1`,
      [id]
    );

    res.json({ ok: true, usuario: rows[0] });
  } catch (err) {
    console.error('❌ admin/users PUT:', err);
    res.status(500).json({ erro: 'Erro interno ao atualizar usuário' });
  }
});

// ─── DELETE /api/admin/users/:id ─────────────────────────────
router.delete('/users/:id', autenticarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query('SELECT email FROM usuarios WHERE id = $1', [id]);
    if (!rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (rows[0].email === ADMIN_EMAIL)
      return res.status(403).json({ erro: 'Não é possível excluir a conta de administrador' });

    await db.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ ok: true, mensagem: 'Usuário excluído com sucesso' });
  } catch (err) {
    console.error('❌ admin/users DELETE:', err);
    res.status(500).json({ erro: 'Erro interno ao excluir usuário' });
  }
});

// ─── GET /api/admin/users/:id/sessao ─────────────────────────
router.get('/users/:id/sessao', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT s.telefone, s.estado
       FROM sessoes_bot s
       WHERE s.usuario_id = $1`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /api/admin/users/:id/vincular ──────────────────────
// Vincula telefone a um usuário
router.post('/users/:id/vincular-lid', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  let { telefone } = req.body;

  if (!telefone) return res.status(400).json({ erro: 'Telefone obrigatório' });

  telefone = telefone.replace(/\D/g, '');
  if (telefone.startsWith('55') && telefone.length > 11) telefone = telefone.slice(2);
  if (telefone.length === 10) {
    const ddd = telefone.slice(0, 2);
    const num = telefone.slice(2);
    if (['6','7','8','9'].includes(num[0])) telefone = ddd + '9' + num;
  }

  try {
    await db.query(
      `UPDATE usuarios SET telefone = $1, whatsapp_ativo = true WHERE id = $2`,
      [telefone, id]
    );

    await db.query(
      `INSERT INTO sessoes_bot (telefone, usuario_id)
       VALUES ($1, $2)
       ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2`,
      [telefone, id]
    );

    res.json({ ok: true, mensagem: 'WhatsApp vinculado com sucesso' });
  } catch (err) {
    console.error('admin/vincular-lid POST:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /api/admin/faturamento ──────────────────────────────
router.get('/faturamento', autenticarAdmin, async (req, res) => {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS faturamento_empresa (
        id SERIAL PRIMARY KEY,
        stripe_invoice_id TEXT UNIQUE,
        stripe_customer_id TEXT,
        usuario_id UUID,
        nome TEXT,
        email TEXT,
        plano TEXT,
        periodo TEXT,
        valor NUMERIC(10,2),
        status TEXT DEFAULT 'pago',
        pago_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    const { rows: pagamentos } = await db.query(`
      SELECT * FROM faturamento_empresa
      WHERE EXTRACT(MONTH FROM pago_em) = $1
        AND EXTRACT(YEAR FROM pago_em) = $2
      ORDER BY pago_em DESC
    `, [mes, ano]);

    const { rows: acum } = await db.query(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM faturamento_empresa WHERE status = 'pago'`
    );

    const total_mes = pagamentos.reduce((s, p) => s + parseFloat(p.valor || 0), 0);

    res.json({
      total_mes,
      total_acumulado: parseFloat(acum[0]?.total || 0),
      pagamentos
    });
  } catch (err) {
    console.error('❌ admin/faturamento GET:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /api/admin/faturamento/evolucao ─────────────────────
router.get('/faturamento/evolucao', autenticarAdmin, async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS faturamento_empresa (
        id SERIAL PRIMARY KEY,
        stripe_invoice_id TEXT UNIQUE,
        stripe_customer_id TEXT,
        usuario_id UUID,
        nome TEXT,
        email TEXT,
        plano TEXT,
        periodo TEXT,
        valor NUMERIC(10,2),
        status TEXT DEFAULT 'pago',
        pago_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    const { rows } = await db.query(`
      SELECT
        EXTRACT(YEAR FROM pago_em)::int  AS ano,
        EXTRACT(MONTH FROM pago_em)::int AS mes,
        COALESCE(SUM(valor), 0)          AS total
      FROM faturamento_empresa
      WHERE status = 'pago'
        AND pago_em >= NOW() - INTERVAL '12 months'
      GROUP BY ano, mes
      ORDER BY ano, mes
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ admin/faturamento/evolucao GET:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /api/admin/resumo ────────────────────────────────────
router.get('/resumo', autenticarAdmin, async (req, res) => {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END), 0) AS receita_total,
        COALESCE(SUM(CASE WHEN tipo = 'despesa' THEN valor ELSE 0 END), 0) AS despesa_total,
        COUNT(*)::int AS total_transacoes
      FROM transacoes
      WHERE EXTRACT(MONTH FROM COALESCE(data_vencimento, criado_em::date)) = $1
        AND EXTRACT(YEAR  FROM COALESCE(data_vencimento, criado_em::date)) = $2
    `, [mes, ano]);

    const r = rows[0];
    res.json({
      receita_total:    parseFloat(r.receita_total),
      despesa_total:    parseFloat(r.despesa_total),
      saldo:            parseFloat(r.receita_total) - parseFloat(r.despesa_total),
      total_transacoes: r.total_transacoes,
      mes,
      ano
    });
  } catch (err) {
    console.error('❌ admin/resumo GET:', err);
    res.status(500).json({ erro: 'Erro interno ao calcular resumo' });
  }
});

// ─── GET /api/admin/transactions ─────────────────────────────
router.get('/transactions', autenticarAdmin, async (req, res) => {
  const mes   = parseInt(req.query.mes)   || new Date().getMonth() + 1;
  const ano   = parseInt(req.query.ano)   || new Date().getFullYear();
  const limit = parseInt(req.query.limit) || 200;

  try {
    const { rows } = await db.query(`
      SELECT
        t.id,
        t.tipo,
        t.descricao,
        t.valor,
        t.data_vencimento  AS data_transacao,
        t.origem,
        t.criado_em,
        c.nome             AS categoria_nome,
        u.nome             AS usuario_nome,
        u.email            AS usuario_email
      FROM transacoes t
      LEFT JOIN categorias c ON c.id = t.categoria_id
      LEFT JOIN usuarios   u ON u.id = t.usuario_id
      WHERE EXTRACT(MONTH FROM COALESCE(t.data_vencimento, t.criado_em::date)) = $1
        AND EXTRACT(YEAR  FROM COALESCE(t.data_vencimento, t.criado_em::date)) = $2
      ORDER BY t.criado_em DESC
      LIMIT $3
    `, [mes, ano, limit]);

    res.json({ transacoes: rows });
  } catch (err) {
    console.error('❌ admin/transactions GET:', err);
    res.status(500).json({ erro: 'Erro interno ao listar transações' });
  }
});

// ─── GET /api/admin/categorias ───────────────────────────────
router.get('/categorias', autenticarAdmin, async (req, res) => {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(c.nome, 'Sem categoria') AS categoria,
        SUM(t.valor)::numeric             AS total
      FROM transacoes t
      LEFT JOIN categorias c ON c.id = t.categoria_id
      WHERE t.tipo = 'despesa'
        AND EXTRACT(MONTH FROM COALESCE(t.data_vencimento, t.criado_em::date)) = $1
        AND EXTRACT(YEAR  FROM COALESCE(t.data_vencimento, t.criado_em::date)) = $2
      GROUP BY COALESCE(c.nome, 'Sem categoria')
      ORDER BY total DESC
      LIMIT 8
    `, [mes, ano]);

    res.json(rows);
  } catch (err) {
    console.error('❌ admin/categorias GET:', err);
    res.status(500).json({ erro: 'Erro interno ao calcular categorias' });
  }
});

// ─── POST /api/admin/users/:id/mensagem ──────────────────────
// Envia mensagem via API Oficial (Meta) para um usuário
router.post('/users/:id/mensagem', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ erro: 'Texto obrigatório' });

  try {
    const { rows } = await db.query(
      `SELECT u.telefone FROM usuarios u WHERE u.id = $1`, [id]
    );
    if (!rows.length || !rows[0].telefone)
      return res.status(404).json({ erro: 'Usuário sem telefone cadastrado' });

    const telefone = rows[0].telefone;
    await botOficial.enviar(telefone, texto);
    console.log(`📤 Mensagem manual enviada via Meta API para ${telefone}`);
    res.json({ ok: true, mensagem: `Enviado para ${telefone}` });
  } catch (err) {
    console.error('❌ admin/mensagem POST:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /api/admin/users/:id/boas-vindas ────────────────────
// Re-envia boas-vindas via API Oficial (Meta)
router.post('/users/:id/boas-vindas', autenticarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT u.nome, u.telefone FROM usuarios u WHERE u.id = $1`, [id]
    );
    if (!rows.length || !rows[0].telefone)
      return res.status(404).json({ erro: 'Usuário sem telefone cadastrado' });

    const { nome, telefone } = rows[0];
    const primeiroNome = nome.split(' ')[0];
    await botOficial.enviar(telefone, botOficial.msgBemVindo(primeiroNome));
    console.log(`✅ Boas-vindas enviadas via Meta API para ${telefone}`);
    res.json({ ok: true, mensagem: `Boas-vindas enviadas para ${telefone}` });
  } catch (err) {
    console.error('❌ admin/boas-vindas POST:', err);
    res.status(500).json({ erro: err.message || 'Falha ao enviar boas-vindas' });
  }
});

module.exports = router;
