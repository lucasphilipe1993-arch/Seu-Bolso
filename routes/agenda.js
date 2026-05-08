// routes/agenda.js — CRUD de compromissos da agenda
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const autenticar = require('../middleware/auth');

router.use(autenticar);

// Garante que a tabela existe (idempotente)
async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agenda (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id       UUID NOT NULL,
      titulo           TEXT NOT NULL,
      data_hora        TIMESTAMPTZ NOT NULL,
      lembrar_antes    INT NOT NULL DEFAULT 30,
      local            TEXT,
      notas            TEXT,
      lembrete_enviado BOOLEAN NOT NULL DEFAULT FALSE,
      cancelado        BOOLEAN NOT NULL DEFAULT FALSE,
      id_curto         TEXT,
      origem           TEXT DEFAULT 'web',
      criado_em        TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_usuario ON agenda(usuario_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_data    ON agenda(data_hora)`).catch(() => {});
}
garantirTabela();

// ── GET /api/agenda ──────────────────────────────────────────────────────────
// Parâmetros opcionais: status=pendente|cancelado|passado, limit, offset
router.get('/', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const agora = new Date();

  let condicao = 'cancelado = FALSE AND data_hora >= $2';
  let params   = [req.usuarioId, agora];

  if (status === 'cancelado') {
    condicao = 'cancelado = TRUE';
    params   = [req.usuarioId];
  } else if (status === 'passado') {
    condicao = 'cancelado = FALSE AND data_hora < $2';
    params   = [req.usuarioId, agora];
  }

  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, lembrar_antes, local, notas,
              lembrete_enviado, cancelado, id_curto, origem, criado_em
       FROM agenda
       WHERE usuario_id = $1 AND ${condicao}
       ORDER BY data_hora ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const total = await db.query(
      `SELECT COUNT(*) FROM agenda WHERE usuario_id = $1 AND ${condicao}`,
      params
    );

    res.json({ compromissos: rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Erro ao listar agenda:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/agenda/proximos ─────────────────────────────────────────────────
// Retorna os próximos N compromissos (para o painel)
router.get('/proximos', async (req, res) => {
  const limit = parseInt(req.query.limit) || 3;
  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, local, notas, id_curto
       FROM agenda
       WHERE usuario_id = $1 AND cancelado = FALSE AND data_hora >= NOW()
       ORDER BY data_hora ASC
       LIMIT $2`,
      [req.usuarioId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar próximos:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/agenda ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { titulo, data_hora, lembrar_antes = 30, local, notas } = req.body;
  if (!titulo || !data_hora)
    return res.status(400).json({ erro: 'titulo e data_hora são obrigatórios' });

  try {
    const { rows } = await db.query(
      `INSERT INTO agenda (usuario_id, titulo, data_hora, lembrar_antes, local, notas, origem)
       VALUES ($1, $2, $3, $4, $5, $6, 'web')
       RETURNING *`,
      [req.usuarioId, titulo, data_hora, lembrar_antes, local || null, notas || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao criar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/agenda/:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { titulo, data_hora, lembrar_antes, local, notas } = req.body;
  try {
    const antes = await db.query(
      'SELECT id FROM agenda WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuarioId]
    );
    if (antes.rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });

    const { rows } = await db.query(
      `UPDATE agenda
       SET titulo=$1, data_hora=$2, lembrar_antes=$3, local=$4, notas=$5,
           lembrete_enviado = FALSE
       WHERE id=$6 AND usuario_id=$7
       RETURNING *`,
      [titulo, data_hora, lembrar_antes ?? 30, local || null, notas || null,
       req.params.id, req.usuarioId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao atualizar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/agenda/:id ───────────────────────────────────────────────────
// Marca como cancelado (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE agenda SET cancelado = TRUE
       WHERE id = $1 AND usuario_id = $2
       RETURNING id`,
      [req.params.id, req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });
    res.json({ mensagem: 'Compromisso cancelado' });
  } catch (err) {
    console.error('Erro ao cancelar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
