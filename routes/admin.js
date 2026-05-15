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
// Retorna usuários com campos adicionais para segmentação:
//   cupom_codigo, acesso_expira_em, stripe_subscription_id, stripe_trial_end
router.get('/users', autenticarAdmin, async (req, res) => {
  try {
    // Garante que as colunas novas existam (migration segura)
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='cupom_codigo'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN cupom_codigo VARCHAR(50);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='acesso_expira_em'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN acesso_expira_em TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='stripe_trial_end'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN stripe_trial_end TIMESTAMPTZ;
        END IF;

        -- ── Localização / IP do cadastro ─────────────────────────
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='cadastro_ip'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN cadastro_ip VARCHAR(60);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='cadastro_pais'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN cadastro_pais VARCHAR(100);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='cadastro_cidade'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN cadastro_cidade VARCHAR(100);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='cadastro_regiao'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN cadastro_regiao VARCHAR(100);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='ultimo_ip'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN ultimo_ip VARCHAR(60);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='usuarios' AND column_name='ultimo_login_em'
        ) THEN
          ALTER TABLE usuarios ADD COLUMN ultimo_login_em TIMESTAMPTZ;
        END IF;

        -- ── Status detalhado do bot ───────────────────────────────
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='sessoes_bot' AND column_name='ultima_msg_em'
        ) THEN
          ALTER TABLE sessoes_bot ADD COLUMN ultima_msg_em TIMESTAMPTZ;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='sessoes_bot' AND column_name='total_msgs'
        ) THEN
          ALTER TABLE sessoes_bot ADD COLUMN total_msgs INTEGER DEFAULT 0;
        END IF;
      END$$;
    `).catch(() => {});

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
        u.cupom_codigo,
        u.acesso_expira_em,
        u.stripe_trial_end,
        u.criado_em,
        u.atualizado_em,
        -- IP e localização do cadastro
        u.cadastro_ip,
        u.cadastro_pais,
        u.cadastro_cidade,
        u.cadastro_regiao,
        u.ultimo_ip,
        u.ultimo_login_em,
        -- ── Sessão do bot via LEFT JOIN (mais eficiente que subqueries) ──
        -- usa_bot = true se existe sessão (independente de whatsapp_ativo)
        CASE WHEN s.usuario_id IS NOT NULL THEN true ELSE false END AS usa_bot,
        s.estado         AS bot_estado,
        s.ultima_msg_em,          -- campo-chave: atualizado pelo handler a cada mensagem
        s.ultima_msg_em  AS bot_ultima_msg_em,   -- alias de compatibilidade
        s.total_msgs     AS bot_total_msgs,
        s.atualizado_em  AS bot_sessao_em,
        -- ── Totais financeiros ────────────────────────────────────────────
        (SELECT COUNT(*) FROM transacoes t WHERE t.usuario_id = u.id)::int  AS total_transacoes,
        (SELECT COALESCE(SUM(t.valor), 0)
           FROM transacoes t
           WHERE t.usuario_id = u.id AND t.tipo = 'receita')::numeric       AS total_receitas,
        (SELECT COALESCE(SUM(t.valor), 0)
           FROM transacoes t
           WHERE t.usuario_id = u.id AND t.tipo = 'despesa')::numeric       AS total_despesas
      FROM usuarios u
      LEFT JOIN LATERAL (
        SELECT usuario_id, estado, ultima_msg_em, total_msgs, atualizado_em
        FROM sessoes_bot
        WHERE usuario_id = u.id
        ORDER BY COALESCE(ultima_msg_em, atualizado_em, '1970-01-01') DESC
        LIMIT 1
      ) s ON true
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

// ══════════════════════════════════════════════════════════════
//  ROTA: Zerar todos os registros de um usuário
//  DELETE /api/admin/users/:id/resetar
//  Remove: transações, contas, categorias, sessões, lembretes,
//          gastos_fixos, limites_gastos, dividas_receber, agenda
//  Preserva: o cadastro do usuário (nome, email, senha, plano)
// ══════════════════════════════════════════════════════════════
router.delete('/users/:id/resetar', autenticarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query('SELECT email, nome FROM usuarios WHERE id = $1', [id]);
    if (!rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    if (rows[0].email === ADMIN_EMAIL)
      return res.status(403).json({ erro: 'Não é possível resetar a conta de administrador' });

    const nome = rows[0].nome;

    // Helper: checa existência de tabela sem usar DO $$ (que não aceita $1)
    async function tabelaExiste(tabela) {
      const r = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
        [tabela]
      );
      return r.rows.length > 0;
    }

    // 1. Lembretes (FK para transacoes — deletar antes)
    await db.query('DELETE FROM lembretes WHERE usuario_id = $1', [id]).catch(() => {});

    // 2. Sessões do bot
    await db.query('DELETE FROM sessoes_bot WHERE usuario_id = $1', [id]).catch(() => {});

    // 3. Dívidas a receber
    if (await tabelaExiste('dividas_receber'))
      await db.query('DELETE FROM dividas_receber WHERE usuario_id = $1', [id]).catch(() => {});

    // 4. Gastos fixos
    if (await tabelaExiste('gastos_fixos'))
      await db.query('DELETE FROM gastos_fixos WHERE usuario_id = $1', [id]).catch(() => {});

    // 5. Limites de gastos
    if (await tabelaExiste('limites_gastos'))
      await db.query('DELETE FROM limites_gastos WHERE usuario_id = $1', [id]).catch(() => {});

    // 6. Agenda
    if (await tabelaExiste('agenda'))
      await db.query('DELETE FROM agenda WHERE usuario_id = $1', [id]).catch(() => {});

    // 7. Transações
    await db.query('DELETE FROM transacoes WHERE usuario_id = $1', [id]).catch(() => {});

    // 8. Categorias do usuário (preserva as globais onde usuario_id IS NULL)
    await db.query('DELETE FROM categorias WHERE usuario_id = $1', [id]).catch(() => {});

    // 9. Contas: remove e recria carteira padrão zerada
    await db.query('DELETE FROM contas WHERE usuario_id = $1', [id]).catch(() => {});
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo) VALUES ($1, 'Carteira', true, 0)`,
      [id]
    );

    // 10. Limpa campos de acesso/trial no usuário
    await db.query(`
      UPDATE usuarios
      SET cupom_codigo     = NULL,
          acesso_expira_em = NULL,
          stripe_trial_end = NULL,
          whatsapp_ativo   = false,
          atualizado_em    = NOW()
      WHERE id = $1
    `, [id]);

    console.log(`🗑️  Reset completo do usuário ${nome} (${id}) executado por admin`);
    res.json({ ok: true, mensagem: `Todos os registros de "${nome}" foram apagados. Cadastro preservado.` });
  } catch (err) {
    console.error('❌ admin/users/resetar DELETE:', err);
    res.status(500).json({ erro: 'Erro ao resetar usuário: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ROTA: Alternar acesso ao bot (bloquear/liberar)
//  PATCH /api/admin/users/:id/bot
//  Body: { ativo: true | false }
// ══════════════════════════════════════════════════════════════
router.patch('/users/:id/bot', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  const { ativo } = req.body;

  if (typeof ativo !== 'boolean')
    return res.status(400).json({ erro: 'Campo "ativo" (boolean) é obrigatório' });

  try {
    const { rows } = await db.query('SELECT email, nome, telefone FROM usuarios WHERE id = $1', [id]);
    if (!rows.length)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    const { nome, telefone } = rows[0];

    await db.query(
      'UPDATE usuarios SET whatsapp_ativo = $1, atualizado_em = NOW() WHERE id = $2',
      [ativo, id]
    );

    if (!ativo) {
      // Bloquear: remove sessão para forçar desconexão imediata
      await db.query('DELETE FROM sessoes_bot WHERE usuario_id = $1', [id]);
      console.log(`🚫 Bot bloqueado para ${nome} (${id}) — sessão removida`);
    } else {
      // Liberar: recria sessão automaticamente se o usuário tiver telefone cadastrado
      if (telefone) {
        await db.query(
          `INSERT INTO sessoes_bot (telefone, usuario_id, estado, contexto)
           VALUES ($1, $2, 'idle', '{}')
           ON CONFLICT (telefone) DO UPDATE
             SET usuario_id    = $2,
                 estado        = 'idle',
                 contexto      = '{}',
                 atualizado_em = NOW()`,
          [telefone, id]
        );
        console.log(`✅ Bot liberado para ${nome} (${id}) — sessão recriada para ${telefone}`);
      } else {
        console.log(`⚠️  Bot liberado para ${nome} (${id}) mas sem telefone cadastrado — sessão não criada`);
      }
    }

    const acao = ativo ? 'liberado' : 'bloqueado';
    const aviso = (ativo && !telefone)
      ? ' (sem telefone cadastrado — vincule o WhatsApp manualmente)'
      : '';

    res.json({
      ok: true,
      mensagem: `Acesso ao bot ${acao} para ${nome}${aviso}`,
      whatsapp_ativo: ativo,
      sessao_criada: ativo && !!telefone,
    });
  } catch (err) {
    console.error('❌ admin/users/bot PATCH:', err);
    res.status(500).json({ erro: 'Erro ao alterar acesso ao bot: ' + err.message });
  }
});

// ─── GET /api/admin/users/:id/sessao ─────────────────────────
router.get('/users/:id/sessao', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT s.telefone, s.estado, s.lid
       FROM sessoes_bot s
       WHERE s.usuario_id = $1`,
      [id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /api/admin/users/:id/vincular-lid ──────────────────
router.post('/users/:id/vincular-lid', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  let { telefone } = req.body;

  if (!telefone) return res.status(400).json({ erro: 'Telefone obrigatório' });

  // Normaliza: remove tudo que não é dígito
  telefone = telefone.replace(/\D/g, '');

  // Remove DDI 55 se vier com ele
  if (telefone.startsWith('55') && telefone.length > 11) telefone = telefone.slice(2);

  // Adiciona o 9 em celulares de 10 dígitos
  if (telefone.length === 10) {
    const ddd = telefone.slice(0, 2);
    const num = telefone.slice(2);
    if (['6','7','8','9'].includes(num[0])) telefone = ddd + '9' + num;
  }

  console.log(`📲 Vinculando telefone normalizado: ${telefone} ao usuário ${id}`);

  try {
    // Atualiza telefone e ativa whatsapp no cadastro
    await db.query(
      `UPDATE usuarios SET telefone = $1, whatsapp_ativo = true WHERE id = $2`,
      [telefone, id]
    );

    // Cria ou atualiza sessão — reseta estado para 'idle' para o bot funcionar limpo
    await db.query(
      `INSERT INTO sessoes_bot (telefone, usuario_id, estado, contexto)
       VALUES ($1, $2, 'idle', '{}')
       ON CONFLICT (telefone) DO UPDATE
         SET usuario_id    = $2,
             estado        = 'idle',
             contexto      = '{}',
             atualizado_em = NOW()`,
      [telefone, id]
    );

    console.log(`✅ Sessão criada/atualizada para telefone ${telefone} → usuário ${id}`);
    res.json({ ok: true, mensagem: `WhatsApp ${telefone} vinculado com sucesso` });
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

// ══════════════════════════════════════════════════════════════
//  ROTA: Bot registra atividade (atualiza atualizado_em da sessão)
//  POST /api/admin/bot-atividade
//  Body: { telefone }   — chamada interna do handler após cada msg
//  Também incrementa total_msgs
// ══════════════════════════════════════════════════════════════
router.post('/bot-atividade', autenticarToken, async (req, res) => {
  const { telefone } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'telefone obrigatório' });

  // Remove todos os não-dígitos para normalizar
  const telLimpo = telefone.replace(/\D/g, '');

  try {
    // Busca a sessão usando LIKE para tolerar variações de formato
    // Ex: '5531991003389', '31991003389', '031991003389' — todas devem dar match
    const result = await db.query(`
      UPDATE sessoes_bot
      SET atualizado_em = NOW(),
          ultima_msg_em = NOW(),
          total_msgs    = COALESCE(total_msgs, 0) + 1
      WHERE regexp_replace(telefone, '[^0-9]', '', 'g') = $1
         OR regexp_replace(telefone, '[^0-9]', '', 'g') = $2
         OR regexp_replace(telefone, '[^0-9]', '', 'g') = $3
      RETURNING telefone, usuario_id
    `, [
      telLimpo,                                          // formato exato
      telLimpo.startsWith('55') ? telLimpo.slice(2) : '55' + telLimpo,  // com/sem DDI 55
      telLimpo.length === 11 ? '55' + telLimpo : telLimpo               // adiciona 55 se 11 dígitos
    ]);

    if (result.rowCount === 0) {
      // Sessão não encontrada — loga para diagnóstico mas não falha
      console.warn(`⚠️  bot-atividade: sessão não encontrada para telefone "${telLimpo}". Verifique se sessoes_bot tem registro para este número.`);
    } else {
      console.log(`✅ bot-atividade: ultima_msg_em atualizado para ${result.rows[0]?.telefone}`);
    }

    res.json({ ok: true, atualizado: result.rowCount > 0 });
  } catch (err) {
    console.error('❌ bot-atividade:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  HELPER: Geolocalização de IP via ip-api.com (gratuito, sem chave)
// ══════════════════════════════════════════════════════════════
async function geolocalizarIP(ip) {
  // IPs locais / privados → sem geo
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { pais: null, cidade: null, regiao: null };
  }
  try {
    const fetch = (await import('node-fetch')).default;
    const res   = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city&lang=pt-BR`, { timeout: 3000 });
    const data  = await res.json();
    if (data.status === 'success') {
      return { pais: data.country || null, cidade: data.city || null, regiao: data.regionName || null };
    }
  } catch { /* silencia erros de geo — não bloqueia o fluxo */ }
  return { pais: null, cidade: null, regiao: null };
}

// ──────────────────────────────────────────────────────────────
//  HELPER: extrai IP real do request (compatível com proxies/Railway)
// ──────────────────────────────────────────────────────────────
function extrairIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || null;
}

// ══════════════════════════════════════════════════════════════
//  ROTA: Registrar IP e localização ao fazer login/cadastro
//  POST /api/admin/registrar-acesso
//  Body: { usuario_id }   — chamada interna após auth bem-sucedida
// ══════════════════════════════════════════════════════════════
router.post('/registrar-acesso', autenticarJWT, async (req, res) => {
  const usuarioId = req.body?.usuario_id || req.usuarioId;
  if (!usuarioId) return res.status(400).json({ erro: 'usuario_id obrigatório' });

  const ip = extrairIP(req);

  try {
    // Atualiza último IP e timestamp de login
    await db.query(
      `UPDATE usuarios SET ultimo_ip = $1, ultimo_login_em = NOW() WHERE id = $2`,
      [ip, usuarioId]
    ).catch(() => {});

    // Verifica se já tem geo salvo; se não, busca e persiste
    const { rows } = await db.query(
      `SELECT cadastro_ip, cadastro_pais FROM usuarios WHERE id = $1`,
      [usuarioId]
    );
    const u = rows[0];
    if (!u?.cadastro_ip && ip) {
      const geo = await geolocalizarIP(ip);
      await db.query(
        `UPDATE usuarios
         SET cadastro_ip = $1, cadastro_pais = $2, cadastro_cidade = $3, cadastro_regiao = $4
         WHERE id = $5`,
        [ip, geo.pais, geo.cidade, geo.regiao, usuarioId]
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ admin/registrar-acesso:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ROTA: Forçar geolocalização de um usuário específico
//  POST /api/admin/users/:id/geo
// ══════════════════════════════════════════════════════════════
router.post('/users/:id/geo', autenticarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT cadastro_ip, ultimo_ip FROM usuarios WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const ip = rows[0].cadastro_ip || rows[0].ultimo_ip;
    if (!ip) return res.status(400).json({ erro: 'Nenhum IP registrado para este usuário' });

    const geo = await geolocalizarIP(ip);
    await db.query(
      `UPDATE usuarios SET cadastro_pais = $1, cadastro_cidade = $2, cadastro_regiao = $3 WHERE id = $4`,
      [geo.pais, geo.cidade, geo.regiao, id]
    );

    res.json({ ok: true, ip, ...geo });
  } catch (err) {
    console.error('❌ admin/users/geo POST:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
module.exports.extrairIP      = extrairIP;
module.exports.geolocalizarIP = geolocalizarIP;
