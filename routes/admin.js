// routes/admin.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const autenticarJWT = require('../middleware/auth');

let _bot = null;

// Injeta a instância do bot (igual ao whatsapp.js)
function setBotInstance(bot) {
  _bot = bot;
}

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
  // Reutiliza o middleware JWT existente como função intermediária
  autenticarJWT(req, res, () => {
    if (req.usuarioEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ erro: 'Acesso restrito ao administrador' });
    }
    next();
  });
}

// ══════════════════════════════════════════════════════════════
//  ROTAS DO BOT — protegidas por x-admin-token (comportamento original)
// ══════════════════════════════════════════════════════════════

// ─── GET /api/admin/status ────────────────────────────────────
router.get('/status', autenticarToken, (req, res) => {
  res.json({
    conectado: _bot?.conectado ?? false,
    tentativas: _bot?._tentativas ?? 0,
    reconectando: _bot?._reconectando ?? false,
    temQR: !!_bot?.qrAtual,
  });
});

// ─── POST /api/admin/reconectar ───────────────────────────────
router.post('/reconectar', autenticarToken, async (req, res) => {
  if (!_bot) return res.status(500).json({ erro: 'Bot não inicializado' });
  try {
    await _bot.reconectar();
    res.json({ ok: true, mensagem: 'Reconexão iniciada' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── DELETE /api/admin/sessao ─────────────────────────────────
router.delete('/sessao', autenticarToken, async (req, res) => {
  try {
    await db.query('DELETE FROM whatsapp_session');
    res.json({ ok: true, mensagem: 'Sessão apagada. Reconecte o bot para gerar novo QR.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── DELETE /api/admin/sessao-e-reconectar ────────────────────
router.delete('/sessao-e-reconectar', autenticarToken, async (req, res) => {
  if (!_bot) return res.status(500).json({ erro: 'Bot não inicializado' });
  try {
    await db.query('DELETE FROM whatsapp_session');
    res.json({ ok: true, mensagem: 'Sessão apagada. Reconexão iniciada, aguarde o QR Code.' });
    setTimeout(() => _bot.reconectar().catch(console.error), 1000);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ROTAS DE ADMINISTRAÇÃO — protegidas por JWT + e-mail admin
// ══════════════════════════════════════════════════════════════

// ─── GET /api/admin/users ─────────────────────────────────────
// Lista todos os usuários cadastrados no site
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
// Cria novo usuário manualmente
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

    // Cria conta bancária padrão
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
// Edita dados de um usuário
router.put('/users/:id', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  const { nome, sobrenome, telefone, plano, senha } = req.body;

  if (!nome)
    return res.status(400).json({ erro: 'Nome é obrigatório' });

  try {
    // Verifica se o usuário existe
    const existe = await db.query('SELECT id FROM usuarios WHERE id = $1', [id]);
    if (!existe.rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    // Atualiza campos básicos
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

    // Atualiza senha se fornecida
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
// Remove um usuário (não pode remover o próprio admin)
router.delete('/users/:id', autenticarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Busca e-mail do usuário alvo para impedir auto-exclusão
    const { rows } = await db.query('SELECT email FROM usuarios WHERE id = $1', [id]);
    if (!rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (rows[0].email === ADMIN_EMAIL)
      return res.status(403).json({ erro: 'Não é possível excluir a conta de administrador' });

    // Cascade: transacoes, contas, sessoes_bot, lembretes são deletados via ON DELETE CASCADE
    await db.query('DELETE FROM usuarios WHERE id = $1', [id]);

    res.json({ ok: true, mensagem: 'Usuário excluído com sucesso' });
  } catch (err) {
    console.error('❌ admin/users DELETE:', err);
    res.status(500).json({ erro: 'Erro interno ao excluir usuário' });
  }
});

// ─── GET /api/admin/users/:id/sessao ─────────────────────────
// Retorna info de sessão e LID de um usuário
router.get('/users/:id/sessao', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT s.telefone, s.lid, s.estado,
              l.lid AS lid_map_lid, l.telefone AS lid_map_telefone
       FROM sessoes_bot s
       LEFT JOIN lid_map l ON l.telefone = s.telefone
       WHERE s.usuario_id = $1`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /api/admin/users/:id/vincular-lid ───────────────────
// Vincula telefone e LID manualmente para um usuário com problema
router.post('/users/:id/vincular-lid', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  let { telefone, lid } = req.body;

  if (!telefone) return res.status(400).json({ erro: 'Telefone obrigatório' });

  // Normaliza telefone
  telefone = telefone.replace(/\D/g, '');
  if (telefone.startsWith('55') && telefone.length > 11) telefone = telefone.slice(2);
  if (telefone.length === 10) {
    const ddd = telefone.slice(0, 2);
    const num = telefone.slice(2);
    if (['6','7','8','9'].includes(num[0])) telefone = ddd + '9' + num;
  }

  try {
    await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});

    await db.query(
      `UPDATE usuarios SET telefone = $1, whatsapp_ativo = true WHERE id = $2`,
      [telefone, id]
    );

    await db.query(
      `INSERT INTO sessoes_bot (telefone, usuario_id, lid)
       VALUES ($1, $2, $3)
       ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2, lid = $3`,
      [telefone, id, lid || null]
    );

    if (lid) {
      const lidFormatado = lid.includes('@lid') ? lid : lid + '@lid';
      await db.query(
        `INSERT INTO lid_map (lid, telefone)
         VALUES ($1, $2)
         ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
        [lidFormatado, telefone]
      );
      await db.query(
        `UPDATE sessoes_bot SET lid = $1 WHERE usuario_id = $2`,
        [lidFormatado, id]
      );
      if (_bot && _bot.lidCache) {
        _bot.lidCache.set(lidFormatado, telefone);
      }
    }

    res.json({ ok: true, mensagem: 'WhatsApp vinculado com sucesso' });
  } catch (err) {
    console.error('admin/vincular-lid POST:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /api/admin/resumo ────────────────────────────────────
// Resumo financeiro global de TODOS os usuários (para o painel de faturamento)
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
      receita_total:     parseFloat(r.receita_total),
      despesa_total:     parseFloat(r.despesa_total),
      saldo:             parseFloat(r.receita_total) - parseFloat(r.despesa_total),
      total_transacoes:  r.total_transacoes,
      mes,
      ano
    });
  } catch (err) {
    console.error('❌ admin/resumo GET:', err);
    res.status(500).json({ erro: 'Erro interno ao calcular resumo' });
  }
});

// ─── GET /api/admin/transactions ─────────────────────────────
// Lista transações de TODOS os usuários com nome do dono
router.get('/transactions', autenticarAdmin, async (req, res) => {
  const mes   = parseInt(req.query.mes)  || new Date().getMonth() + 1;
  const ano   = parseInt(req.query.ano)  || new Date().getFullYear();
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
// Top categorias de despesa de todos os usuários (para gráfico pizza)
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

module.exports = { router, setBotInstance };

// PLACEHOLDER - will be replaced
