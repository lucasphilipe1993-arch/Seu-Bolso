// routes/gastos-fixos.js
const express    = require('express');
const router     = express.Router();
const db         = require('../database/db');
const autenticar = require('../middleware/auth');

// Garante que a tabela existe
async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gastos_fixos (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id      UUID NOT NULL,
      descricao       TEXT NOT NULL,
      valor           NUMERIC(12,2) NOT NULL,
      categoria       TEXT NOT NULL DEFAULT 'Outros',
      dia_vencimento  INT,
      ativo           BOOLEAN NOT NULL DEFAULT TRUE,
      id_curto        TEXT,
      criado_em       TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  // Garante coluna id_curto caso tabela já existisse sem ela
  await db.query(`ALTER TABLE gastos_fixos ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
}

// GET /api/gastos-fixos — lista todos os gastos fixos ativos do usuário
router.get('/', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { rows } = await db.query(
      `SELECT id, descricao, valor, categoria, dia_vencimento, ativo, id_curto, criado_em
       FROM gastos_fixos
       WHERE usuario_id = $1 AND ativo = true
       ORDER BY dia_vencimento ASC NULLS LAST, descricao ASC`,
      [req.usuarioId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[gastos-fixos] GET:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar gastos fixos' });
  }
});

// POST /api/gastos-fixos — cria novo gasto fixo
router.post('/', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { descricao, valor, categoria, dia_vencimento } = req.body;
    if (!descricao || !valor) return res.status(400).json({ erro: 'descricao e valor são obrigatórios' });

    // Gera id_curto simples
    const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let idCurto = '';
    for (let i = 0; i < 3; i++) idCurto += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];

    const { rows } = await db.query(
      `INSERT INTO gastos_fixos (usuario_id, descricao, valor, categoria, dia_vencimento, id_curto)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.usuarioId, descricao.trim(), parseFloat(valor), categoria || 'Outros', dia_vencimento || null, idCurto]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[gastos-fixos] POST:', err.message);
    res.status(500).json({ erro: 'Erro ao criar gasto fixo' });
  }
});

// PUT /api/gastos-fixos/:id — atualiza gasto fixo
router.put('/:id', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { descricao, valor, categoria, dia_vencimento, ativo } = req.body;
    const { rows } = await db.query(
      `UPDATE gastos_fixos
       SET descricao = COALESCE($1, descricao),
           valor     = COALESCE($2, valor),
           categoria = COALESCE($3, categoria),
           dia_vencimento = $4,
           ativo     = COALESCE($5, ativo)
       WHERE id = $6 AND usuario_id = $7
       RETURNING *`,
      [
        descricao?.trim() || null,
        valor ? parseFloat(valor) : null,
        categoria || null,
        dia_vencimento || null,
        ativo !== undefined ? ativo : null,
        req.params.id,
        req.usuarioId,
      ]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Gasto fixo não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[gastos-fixos] PUT:', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar gasto fixo' });
  }
});

// DELETE /api/gastos-fixos/:id — desativa (soft delete) gasto fixo
router.delete('/:id', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { rows } = await db.query(
      `UPDATE gastos_fixos SET ativo = false
       WHERE id = $1 AND usuario_id = $2
       RETURNING descricao`,
      [req.params.id, req.usuarioId]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Gasto fixo não encontrado' });
    res.json({ ok: true, mensagem: `"${rows[0].descricao}" removido.` });
  } catch (err) {
    console.error('[gastos-fixos] DELETE:', err.message);
    res.status(500).json({ erro: 'Erro ao remover gasto fixo' });
  }
});

module.exports = router;
