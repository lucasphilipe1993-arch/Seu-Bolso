// routes/limites.js
const express    = require('express');
const router     = express.Router();
const db         = require('../database/db');
const autenticar = require('../middleware/auth');

async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS limites_gastos (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id   UUID NOT NULL,
      categoria    TEXT NOT NULL,
      valor_limite NUMERIC(12,2) NOT NULL,
      periodo      TEXT NOT NULL DEFAULT 'mensal',
      ativo        BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

// GET /api/limites — lista todos os limites ativos
router.get('/', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { rows } = await db.query(
      `SELECT id, categoria, valor_limite, periodo, ativo, criado_em
       FROM limites_gastos
       WHERE usuario_id = $1 AND ativo = true
       ORDER BY categoria ASC`,
      [req.usuarioId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[limites] GET:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar limites' });
  }
});

// POST /api/limites — cria ou atualiza (upsert por categoria+período)
router.post('/', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { categoria, valor_limite, periodo } = req.body;
    if (!categoria || !valor_limite) return res.status(400).json({ erro: 'categoria e valor_limite são obrigatórios' });

    // Upsert: se já existe limite para categoria+periodo, atualiza
    const existente = await db.query(
      `SELECT id FROM limites_gastos
       WHERE usuario_id=$1 AND LOWER(categoria)=LOWER($2) AND periodo=$3`,
      [req.usuarioId, categoria, periodo || 'mensal']
    );

    let rows;
    if (existente.rows.length) {
      const upd = await db.query(
        `UPDATE limites_gastos SET valor_limite=$1, ativo=true
         WHERE id=$2 RETURNING *`,
        [parseFloat(valor_limite), existente.rows[0].id]
      );
      rows = upd.rows;
    } else {
      const ins = await db.query(
        `INSERT INTO limites_gastos (usuario_id, categoria, valor_limite, periodo)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.usuarioId, categoria.trim(), parseFloat(valor_limite), periodo || 'mensal']
      );
      rows = ins.rows;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[limites] POST:', err.message);
    res.status(500).json({ erro: 'Erro ao salvar limite' });
  }
});

// PUT /api/limites/:id — edita limite existente
router.put('/:id', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { categoria, valor_limite, periodo } = req.body;
    const { rows } = await db.query(
      `UPDATE limites_gastos
       SET categoria    = COALESCE($1, categoria),
           valor_limite = COALESCE($2, valor_limite),
           periodo      = COALESCE($3, periodo)
       WHERE id = $4 AND usuario_id = $5
       RETURNING *`,
      [
        categoria?.trim() || null,
        valor_limite ? parseFloat(valor_limite) : null,
        periodo || null,
        req.params.id,
        req.usuarioId,
      ]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Limite não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[limites] PUT:', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar limite' });
  }
});

// DELETE /api/limites/:id — remove limite
router.delete('/:id', autenticar, async (req, res) => {
  try {
    await garantirTabela();
    const { rows } = await db.query(
      `UPDATE limites_gastos SET ativo = false
       WHERE id = $1 AND usuario_id = $2
       RETURNING categoria`,
      [req.params.id, req.usuarioId]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Limite não encontrado' });
    res.json({ ok: true, mensagem: `Limite de "${rows[0].categoria}" removido.` });
  } catch (err) {
    console.error('[limites] DELETE:', err.message);
    res.status(500).json({ erro: 'Erro ao remover limite' });
  }
});

module.exports = router;
