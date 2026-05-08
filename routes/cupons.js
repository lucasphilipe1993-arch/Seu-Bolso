// routes/cupons.js
// ─────────────────────────────────────────────────────────────────────────────
// Gerenciamento de cupons de acesso gratuito
//
// Tabela necessária no banco (rode no schema.sql):
//
//   CREATE TABLE IF NOT EXISTS cupons (
//     id           SERIAL PRIMARY KEY,
//     codigo       VARCHAR(50) UNIQUE NOT NULL,
//     plano        VARCHAR(20) NOT NULL DEFAULT 'basico',
//     dias         INTEGER     NOT NULL DEFAULT 30,
//     descricao    TEXT,
//     usos_max     INTEGER     DEFAULT NULL,   -- NULL = ilimitado
//     usos_atual   INTEGER     NOT NULL DEFAULT 0,
//     ativo        BOOLEAN     NOT NULL DEFAULT true,
//     expira_em    TIMESTAMPTZ DEFAULT NULL,   -- NULL = sem expiração
//     criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
// Exemplo de inserção de cupom:
//   INSERT INTO cupons (codigo, plano, dias, descricao, usos_max)
//   VALUES ('AMIGO2025', 'basico', 30, 'Acesso gratuito por 30 dias — convite pessoal', 50);
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const autenticar = require('../middleware/auth');

// ── POST /api/cupons/validar  (público — chamado antes do cadastro) ──────────
router.post('/validar', async (req, res) => {
  const { codigo } = req.body;

  if (!codigo || typeof codigo !== 'string') {
    return res.status(400).json({ valido: false, erro: 'Código não informado.' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, codigo, plano, dias, descricao, usos_max, usos_atual, ativo, expira_em
       FROM cupons
       WHERE UPPER(codigo) = UPPER($1)`,
      [codigo.trim()]
    );

    if (rows.length === 0) {
      return res.status(404).json({ valido: false, erro: 'Cupom não encontrado.' });
    }

    const cupom = rows[0];

    if (!cupom.ativo) {
      return res.status(400).json({ valido: false, erro: 'Este cupom está desativado.' });
    }

    if (cupom.expira_em && new Date(cupom.expira_em) < new Date()) {
      return res.status(400).json({ valido: false, erro: 'Este cupom expirou.' });
    }

    if (cupom.usos_max !== null && cupom.usos_atual >= cupom.usos_max) {
      return res.status(400).json({ valido: false, erro: 'Este cupom atingiu o limite de usos.' });
    }

    return res.json({
      valido:    true,
      plano:     cupom.plano,
      dias:      cupom.dias,
      descricao: cupom.descricao || `Acesso gratuito por ${cupom.dias} dias`,
    });

  } catch (err) {
    console.error('❌ Erro ao validar cupom:', err.message);
    return res.status(500).json({ valido: false, erro: 'Erro interno ao validar cupom.' });
  }
});

// ── POST /api/cupons/resgatar  (chamado internamente pelo cadastro) ───────────
// Incrementa o contador de usos — chame isso após criar o usuário com sucesso.
router.post('/resgatar', async (req, res) => {
  const { codigo, usuarioId } = req.body;

  if (!codigo || !usuarioId) {
    return res.status(400).json({ erro: 'Dados incompletos.' });
  }

  try {
    // Incrementa uso
    await db.query(
      `UPDATE cupons SET usos_atual = usos_atual + 1 WHERE UPPER(codigo) = UPPER($1)`,
      [codigo.trim()]
    );

    // Calcula data de expiração do acesso do usuário
    const { rows } = await db.query(
      `SELECT dias FROM cupons WHERE UPPER(codigo) = UPPER($1)`,
      [codigo.trim()]
    );
    const dias = rows[0]?.dias || 30;

    const expira = new Date();
    expira.setDate(expira.getDate() + dias);

    // Atualiza o usuário com acesso gratuito temporário
    await db.query(
      `UPDATE usuarios
       SET plano = $1, whatsapp_ativo = true, cupom_codigo = $2, acesso_expira_em = $3
       WHERE id = $4`,
      ['basico', codigo.trim().toUpperCase(), expira.toISOString(), usuarioId]
    );

    return res.json({ ok: true, expira: expira.toISOString() });

  } catch (err) {
    console.error('❌ Erro ao resgatar cupom:', err.message);
    return res.status(500).json({ erro: 'Erro ao resgatar cupom.' });
  }
});

// ── Admin: listar cupons ─────────────────────────────────────────────────────
// GET /api/cupons  (requer autenticação de admin — adapte ao seu middleware)
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, codigo, plano, dias, descricao, usos_max, usos_atual, ativo, expira_em, criado_em
       FROM cupons ORDER BY criado_em DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── Admin: criar cupom ───────────────────────────────────────────────────────
// POST /api/cupons
router.post('/', autenticar, async (req, res) => {
  const { codigo, plano = 'basico', dias = 30, descricao, usos_max, expira_em } = req.body;

  if (!codigo) return res.status(400).json({ erro: 'Código obrigatório.' });

  try {
    const { rows } = await db.query(
      `INSERT INTO cupons (codigo, plano, dias, descricao, usos_max, expira_em)
       VALUES (UPPER($1), $2, $3, $4, $5, $6)
       RETURNING *`,
      [codigo.trim(), plano, dias, descricao || null, usos_max || null, expira_em || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ erro: 'Já existe um cupom com este código.' });
    }
    console.error('❌ Erro ao criar cupom:', err.message);
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── Admin: ativar/desativar cupom ────────────────────────────────────────────
// PATCH /api/cupons/:id
router.patch('/:id', autenticar, async (req, res) => {
  const { ativo } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE cupons SET ativo = $1 WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Cupom não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

module.exports = router;
