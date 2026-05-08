// routes/dividas.js — CRUD de dívidas a receber
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const autenticar = require('../middleware/auth');

router.use(autenticar);

// Garante que a tabela existe (idempotente)
async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dividas_receber (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id       UUID NOT NULL,
      devedor          TEXT NOT NULL,
      descricao        TEXT,
      valor            NUMERIC(12,2) NOT NULL,
      data_vencimento  DATE,
      data_recebimento DATE,
      status           TEXT NOT NULL DEFAULT 'pendente',
      origem           TEXT DEFAULT 'manual',
      mensagem_raw     TEXT,
      id_curto         TEXT,
      criado_em        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dividas_usuario ON dividas_receber(usuario_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dividas_status  ON dividas_receber(status)`);
}

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function gerarIdCurto() {
  let tentativas = 0;
  while (tentativas < 20) {
    let id = '';
    for (let i = 0; i < 3; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    const { rows } = await db.query(`SELECT id FROM dividas_receber WHERE id_curto = $1`, [id]);
    if (rows.length === 0) return id;
    tentativas++;
  }
  return Math.random().toString(36).slice(2, 5).toUpperCase();
}

// ── GET /api/dividas ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await garantirTabela();

    const { status = 'pendente' } = req.query;
    const usuarioId = req.usuarioId;

    const statusValidos = ['pendente', 'recebido', 'cancelado'];
    const whereStatus = status === 'todas'
      ? `status = ANY($2)`
      : `status = $2`;
    const paramStatus = status === 'todas'
      ? statusValidos
      : status;

    const { rows: dividas } = await db.query(
      `SELECT * FROM dividas_receber
       WHERE usuario_id = $1 AND ${whereStatus}
       ORDER BY
         CASE status WHEN 'pendente' THEN 0 ELSE 1 END,
         data_vencimento ASC NULLS LAST,
         criado_em DESC`,
      [usuarioId, paramStatus]
    );

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const em7dias = new Date(hoje);
    em7dias.setDate(em7dias.getDate() + 7);

    // KPIs separados (sempre sobre todos os status relevantes)
    const { rows: kpiRows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pendente'                                          THEN valor END), 0) AS pendente,
        COALESCE(SUM(CASE WHEN status = 'pendente'
                           AND data_vencimento IS NOT NULL
                           AND data_vencimento >= $2
                           AND data_vencimento <= $3                                        THEN valor END), 0) AS vencendo7dias,
        COALESCE(SUM(CASE WHEN status = 'pendente'
                           AND data_vencimento IS NOT NULL
                           AND data_vencimento < $2                                         THEN valor END), 0) AS atrasado_valor,
        COUNT(CASE  WHEN status = 'pendente'
                     AND data_vencimento IS NOT NULL
                     AND data_vencimento < $2                                               THEN 1 END)         AS atrasadas,
        COUNT(CASE  WHEN status = 'pendente'
                     AND data_vencimento IS NOT NULL
                     AND data_vencimento = $2                                               THEN 1 END)         AS vencendo_hoje,
        COALESCE(SUM(CASE WHEN status = 'recebido'
                           AND EXTRACT(MONTH FROM data_recebimento) = EXTRACT(MONTH FROM NOW())
                           AND EXTRACT(YEAR  FROM data_recebimento) = EXTRACT(YEAR  FROM NOW()) THEN valor END), 0) AS recebido_mes
      FROM dividas_receber
      WHERE usuario_id = $1
    `, [usuarioId, hoje.toISOString().split('T')[0], em7dias.toISOString().split('T')[0]]);

    const k = kpiRows[0];
    res.json({
      dividas,
      kpi: {
        pendente:      parseFloat(k.pendente),
        vencendo7dias: parseFloat(k.vencendo7dias),
        atrasadoValor: parseFloat(k.atrasado_valor),
        atrasadas:     parseInt(k.atrasadas),
        vencendoHoje:  parseInt(k.vencendo_hoje),
        recebidoMes:   parseFloat(k.recebido_mes),
      },
    });
  } catch (err) {
    console.error('Erro ao listar dívidas:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/dividas ────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    await garantirTabela();

    const { devedor, descricao, valor, data_vencimento, origem = 'manual', mensagem_raw } = req.body;

    if (!devedor || !devedor.trim())
      return res.status(400).json({ erro: 'Nome do devedor é obrigatório' });
    if (!valor || parseFloat(valor) <= 0)
      return res.status(400).json({ erro: 'Valor deve ser maior que zero' });

    const idCurto = await gerarIdCurto();

    const { rows } = await db.query(
      `INSERT INTO dividas_receber
         (usuario_id, devedor, descricao, valor, data_vencimento, origem, mensagem_raw, id_curto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.usuarioId,
        devedor.trim(),
        descricao?.trim() || null,
        parseFloat(valor),
        data_vencimento || null,
        origem,
        mensagem_raw || null,
        idCurto,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro ao criar dívida:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/dividas/:id/quitar ─────────────────────────────
router.post('/:id/quitar', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE dividas_receber
       SET status = 'recebido', data_recebimento = CURRENT_DATE
       WHERE id = $1 AND usuario_id = $2 AND status = 'pendente'
       RETURNING *`,
      [req.params.id, req.usuarioId]
    );

    if (rows.length === 0)
      return res.status(404).json({ erro: 'Dívida não encontrada ou já quitada' });

    const d = rows[0];

    // Registra como receita na tabela de transações
    await db.query(
      `INSERT INTO transacoes
         (usuario_id, tipo, descricao, valor, data_vencimento, data_pagamento, pago, origem)
       VALUES ($1, 'receita', $2, $3, CURRENT_DATE, CURRENT_DATE, true, 'web')`,
      [req.usuarioId, `Recebido de ${d.devedor}`, d.valor]
    );

    res.json({ ok: true, divida: d });
  } catch (err) {
    console.error('Erro ao quitar dívida:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/dividas/:id/cancelar ───────────────────────────
router.post('/:id/cancelar', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE dividas_receber
       SET status = 'cancelado'
       WHERE id = $1 AND usuario_id = $2 AND status = 'pendente'
       RETURNING id`,
      [req.params.id, req.usuarioId]
    );

    if (rows.length === 0)
      return res.status(404).json({ erro: 'Dívida não encontrada ou já encerrada' });

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao cancelar dívida:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/dividas/:id ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM dividas_receber
       WHERE id = $1 AND usuario_id = $2
       RETURNING id`,
      [req.params.id, req.usuarioId]
    );

    if (rows.length === 0)
      return res.status(404).json({ erro: 'Dívida não encontrada' });

    res.json({ mensagem: 'Dívida removida' });
  } catch (err) {
    console.error('Erro ao deletar dívida:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
