// routes/transactions.js — CRUD de transações + resumo dashboard
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const autenticar = require('../middleware/auth');

// Todas as rotas exigem autenticação
router.use(autenticar);

// ── GET /api/transactions ────────────────────────────────
// Lista transações com filtros opcionais
router.get('/', async (req, res) => {
  const { tipo, mes, ano, pago, conta_id, categoria_id, limit = 50, offset = 0 } = req.query;

  let where = ['t.usuario_id = $1'];
  let params = [req.usuarioId];
  let i = 2;

  if (tipo) { where.push(`t.tipo = $${i++}`); params.push(tipo); }
  if (pago !== undefined) { where.push(`t.pago = $${i++}`); params.push(pago === 'true'); }
  if (conta_id) { where.push(`t.conta_id = $${i++}`); params.push(conta_id); }
  if (categoria_id) { where.push(`t.categoria_id = $${i++}`); params.push(categoria_id); }
  if (mes && ano) {
    where.push(`EXTRACT(MONTH FROM t.data_vencimento) = $${i++}`);
    params.push(parseInt(mes));
    where.push(`EXTRACT(YEAR FROM t.data_vencimento) = $${i++}`);
    params.push(parseInt(ano));
  }

  const whereStr = where.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT t.*, c.nome as categoria_nome, c.cor as categoria_cor,
              ct.nome as conta_nome
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       LEFT JOIN contas ct ON ct.id = t.conta_id
       WHERE ${whereStr}
       ORDER BY t.data_vencimento DESC, t.criado_em DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const total = await db.query(
      `SELECT COUNT(*) FROM transacoes t WHERE ${whereStr}`,
      params
    );

    res.json({ transacoes: rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Erro ao listar transações:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/transactions/resumo ─────────────────────────
// Dados do dashboard: receitas, despesas, saldo, por categoria
router.get('/resumo', async (req, res) => {
  const { mes, ano } = req.query;
  const mesAtual = mes || new Date().getMonth() + 1;
  const anoAtual = ano || new Date().getFullYear();

  try {
    // Totais do mês
    const totais = await db.query(
      `SELECT
        SUM(CASE WHEN tipo = 'receita' AND pago = true  THEN valor ELSE 0 END) AS receita_paga,
        SUM(CASE WHEN tipo = 'receita' AND pago = false THEN valor ELSE 0 END) AS receita_pendente,
        SUM(CASE WHEN tipo = 'despesa' AND pago = true  THEN valor ELSE 0 END) AS despesa_paga,
        SUM(CASE WHEN tipo = 'despesa' AND pago = false THEN valor ELSE 0 END) AS despesa_pendente
       FROM transacoes
       WHERE usuario_id = $1
         AND EXTRACT(MONTH FROM data_vencimento) = $2
         AND EXTRACT(YEAR  FROM data_vencimento) = $3`,
      [req.usuarioId, mesAtual, anoAtual]
    );

    // Gastos por categoria (despesas pagas)
    const porCategoria = await db.query(
      `SELECT c.nome, c.cor, SUM(t.valor) AS total
       FROM transacoes t
       JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND EXTRACT(MONTH FROM t.data_vencimento) = $2
         AND EXTRACT(YEAR  FROM t.data_vencimento) = $3
       GROUP BY c.nome, c.cor
       ORDER BY total DESC`,
      [req.usuarioId, mesAtual, anoAtual]
    );

    // Saldo das contas
    const saldoContas = await db.query(
      `SELECT SUM(saldo) AS saldo_total FROM contas WHERE usuario_id = $1`,
      [req.usuarioId]
    );

    const t = totais.rows[0];
    const receita = parseFloat(t.receita_paga || 0);
    const despesa = parseFloat(t.despesa_paga || 0);
    const saldoBanco = parseFloat(saldoContas.rows[0].saldo_total || 0);

    res.json({
      receita_paga:      receita,
      receita_pendente:  parseFloat(t.receita_pendente || 0),
      despesa_paga:      despesa,
      despesa_pendente:  parseFloat(t.despesa_pendente || 0),
      saldo_disponivel:  receita - despesa + saldoBanco,
      saldo_previsto:    (receita + parseFloat(t.receita_pendente || 0))
                       - (despesa + parseFloat(t.despesa_pendente || 0)) + saldoBanco,
      por_categoria: porCategoria.rows,
    });
  } catch (err) {
    console.error('Erro resumo:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/transactions ───────────────────────────────
router.post('/', async (req, res) => {
  const { tipo, descricao, valor, categoria_id, conta_id, data_vencimento, pago, fixo } = req.body;

  if (!tipo || !descricao || !valor)
    return res.status(400).json({ erro: 'tipo, descricao e valor são obrigatórios' });

  try {
    const { rows } = await db.query(
      `INSERT INTO transacoes
         (usuario_id, tipo, descricao, valor, categoria_id, conta_id,
          data_vencimento, pago, fixo, origem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'web')
       RETURNING *`,
      [req.usuarioId, tipo, descricao, valor, categoria_id || null,
       conta_id || null, data_vencimento || null,
       pago || false, fixo || false]
    );

    // Atualiza saldo da conta se pago
    if (pago && conta_id) {
      const sinal = tipo === 'receita' ? 1 : -1;
      await db.query(
        'UPDATE contas SET saldo = saldo + $1 WHERE id = $2',
        [sinal * parseFloat(valor), conta_id]
      );
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro criar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/transactions/:id ────────────────────────────
router.put('/:id', async (req, res) => {
  const { descricao, valor, categoria_id, conta_id, data_vencimento, pago, fixo } = req.body;

  try {
    const antes = await db.query(
      'SELECT * FROM transacoes WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuarioId]
    );
    if (antes.rows.length === 0)
      return res.status(404).json({ erro: 'Transação não encontrada' });

    const original = antes.rows[0];

    const { rows } = await db.query(
      `UPDATE transacoes SET
         descricao=$1, valor=$2, categoria_id=$3, conta_id=$4,
         data_vencimento=$5, pago=$6, fixo=$7
       WHERE id=$8 AND usuario_id=$9
       RETURNING *`,
      [descricao, valor, categoria_id || null, conta_id || null,
       data_vencimento || null, pago, fixo,
       req.params.id, req.usuarioId]
    );

    // Ajusta saldo: reverte a anterior e aplica a nova
    if (original.conta_id) {
      const sinalOld = original.tipo === 'receita' ? 1 : -1;
      const valorOld = original.pago ? sinalOld * parseFloat(original.valor) : 0;
      const sinalNew = original.tipo === 'receita' ? 1 : -1;
      const valorNew = pago ? sinalNew * parseFloat(valor) : 0;
      const diff = valorNew - valorOld;
      if (diff !== 0) {
        await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2',
          [diff, original.conta_id]);
      }
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Erro atualizar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/transactions/:id ─────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2 RETURNING *',
      [req.params.id, req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Transação não encontrada' });

    // Reverte saldo se estava pago
    const t = rows[0];
    if (t.pago && t.conta_id) {
      const sinal = t.tipo === 'receita' ? -1 : 1; // reverte
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2',
        [sinal * parseFloat(t.valor), t.conta_id]);
    }

    res.json({ mensagem: 'Transação removida com sucesso' });
  } catch (err) {
    console.error('Erro deletar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/transactions/contas ─────────────────────────
router.get('/contas', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM contas WHERE usuario_id = $1 ORDER BY padrao DESC, nome',
      [req.usuarioId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/transactions/categorias ────────────────────
router.get('/categorias', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM categorias
       WHERE usuario_id = $1 OR usuario_id IS NULL
       ORDER BY nome`,
      [req.usuarioId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
