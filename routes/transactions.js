// routes/transactions.js — CRUD de transações + resumo dashboard
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const autenticar = require('../middleware/auth');

router.use(autenticar);

// ── GET /api/transactions ────────────────────────────────────
// Aceita: tipo, mes, ano, pago, conta_id, categoria_id, limit, offset
// Retorna campos com data_transacao (alias de data_vencimento) para o dashboard
router.get('/', async (req, res) => {
  const { tipo, mes, ano, pago, conta_id, categoria_id, limit = 50, offset = 0 } = req.query;

  let where = ['t.usuario_id = $1'];
  let params = [req.usuarioId];
  let i = 2;

  if (tipo)       { where.push(`t.tipo = $${i++}`);        params.push(tipo); }
  if (pago !== undefined) { where.push(`t.pago = $${i++}`); params.push(pago === 'true'); }
  if (conta_id)   { where.push(`t.conta_id = $${i++}`);    params.push(conta_id); }
  if (categoria_id) { where.push(`t.categoria_id = $${i++}`); params.push(categoria_id); }
  if (mes && ano) {
    // Filtra por data_vencimento OU data_pagamento para pegar transações do WhatsApp (pago=true, data_pagamento=hoje)
    where.push(`(
      EXTRACT(MONTH FROM t.data_vencimento) = $${i} AND EXTRACT(YEAR FROM t.data_vencimento) = $${i+1}
      OR
      EXTRACT(MONTH FROM t.data_pagamento)  = $${i} AND EXTRACT(YEAR FROM t.data_pagamento)  = $${i+1}
    )`);
    params.push(parseInt(mes), parseInt(ano));
    i += 2;
  }

  const whereStr = where.join(' AND ');

  try {
    const { rows } = await db.query(
      `SELECT
         t.id,
         t.tipo,
         t.descricao,
         t.valor,
         t.pago,
         t.fixo,
         t.origem,
         t.mensagem_raw   AS mensagem_wa,
         -- expõe data_transacao para compatibilidade com o dashboard
         COALESCE(t.data_pagamento, t.data_vencimento) AS data_transacao,
         t.data_vencimento,
         t.data_pagamento,
         t.criado_em,
         t.status,
         c.nome           AS categoria_nome,
         c.cor            AS categoria_cor,
         ct.nome          AS conta_nome
       FROM transacoes t
       LEFT JOIN categorias c  ON c.id  = t.categoria_id
       LEFT JOIN contas     ct ON ct.id = t.conta_id
       WHERE ${whereStr}
       ORDER BY COALESCE(t.data_pagamento, t.data_vencimento) DESC, t.criado_em DESC
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

// ── GET /api/transactions/resumo ─────────────────────────────
// Retorna: { receita_total, despesa_total, saldo } — compatível com dashboard
router.get('/resumo', async (req, res) => {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  try {
    const totais = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'receita' AND pago = true  THEN valor ELSE 0 END), 0) AS receita_total,
         COALESCE(SUM(CASE WHEN tipo = 'receita' AND pago = false THEN valor ELSE 0 END), 0) AS receita_pendente,
         COALESCE(SUM(CASE WHEN tipo = 'despesa' AND pago = true  THEN valor ELSE 0 END), 0) AS despesa_total,
         COALESCE(SUM(CASE WHEN tipo = 'despesa' AND pago = false THEN valor ELSE 0 END), 0) AS despesa_pendente
       FROM transacoes
       WHERE usuario_id = $1
         AND (
           (EXTRACT(MONTH FROM data_vencimento) = $2 AND EXTRACT(YEAR FROM data_vencimento) = $3)
           OR
           (EXTRACT(MONTH FROM data_pagamento)  = $2 AND EXTRACT(YEAR FROM data_pagamento)  = $3)
         )`,
      [req.usuarioId, mes, ano]
    );

    const saldoContas = await db.query(
      `SELECT COALESCE(SUM(saldo), 0) AS saldo_total FROM contas WHERE usuario_id = $1`,
      [req.usuarioId]
    );

    const t = totais.rows[0];
    const receita = parseFloat(t.receita_total);
    const despesa = parseFloat(t.despesa_total);
    const saldoBanco = parseFloat(saldoContas.rows[0].saldo_total);

    res.json({
      receita_total:    receita,
      despesa_total:    despesa,
      saldo:            receita - despesa,
      saldo_banco:      saldoBanco,
      receita_pendente: parseFloat(t.receita_pendente),
      despesa_pendente: parseFloat(t.despesa_pendente),
    });
  } catch (err) {
    console.error('Erro resumo:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/transactions/por-categoria ──────────────────────
// Retorna: [{ categoria, total }] — usado no painel de categorias
router.get('/por-categoria', async (req, res) => {
  const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
  const ano = parseInt(req.query.ano) || new Date().getFullYear();

  try {
    const { rows } = await db.query(
      `SELECT
         COALESCE(c.nome, 'Outros') AS categoria,
         c.cor,
         COALESCE(SUM(t.valor), 0)  AS total
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND (
           (EXTRACT(MONTH FROM t.data_vencimento) = $2 AND EXTRACT(YEAR FROM t.data_vencimento) = $3)
           OR
           (EXTRACT(MONTH FROM t.data_pagamento)  = $2 AND EXTRACT(YEAR FROM t.data_pagamento)  = $3)
         )
       GROUP BY COALESCE(c.nome, 'Outros'), c.cor
       ORDER BY total DESC`,
      [req.usuarioId, mes, ano]
    );

    res.json(rows);
  } catch (err) {
    console.error('Erro por-categoria:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/transactions ───────────────────────────────────
router.post('/', async (req, res) => {
  const { tipo, descricao, valor, categoria_id, conta_id, data_vencimento, pago, fixo, origem } = req.body;

  if (!tipo || !descricao || !valor)
    return res.status(400).json({ erro: 'tipo, descricao e valor são obrigatórios' });

  try {
    const isPago = pago !== false && pago !== 'false'; // padrão true para transações manuais
    const dataVenc = data_vencimento || new Date().toISOString().split('T')[0];
    const dataPag  = isPago ? dataVenc : null;

    const { rows } = await db.query(
      `INSERT INTO transacoes
         (usuario_id, tipo, descricao, valor, categoria_id, conta_id,
          data_vencimento, data_pagamento, pago, fixo, origem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.usuarioId, tipo, descricao, parseFloat(valor),
       categoria_id || null, conta_id || null,
       dataVenc, dataPag, isPago, fixo || false,
       origem || 'web']
    );

    if (isPago && conta_id) {
      const sinal = tipo === 'receita' ? 1 : -1;
      await db.query(
        'UPDATE contas SET saldo = saldo + $1 WHERE id = $2 AND usuario_id = $3',
        [sinal * parseFloat(valor), conta_id, req.usuarioId]
      );
    }

    // Retorna com campo data_transacao para compatibilidade
    const t = rows[0];
    res.status(201).json({
      ...t,
      data_transacao: t.data_pagamento || t.data_vencimento,
    });
  } catch (err) {
    console.error('Erro criar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/transactions/:id ────────────────────────────────
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
    const isPago   = pago === true || pago === 'true';
    const dataPag  = isPago ? (data_vencimento || original.data_vencimento) : null;

    const { rows } = await db.query(
      `UPDATE transacoes SET
         descricao=$1, valor=$2, categoria_id=$3, conta_id=$4,
         data_vencimento=$5, data_pagamento=$6, pago=$7, fixo=$8
       WHERE id=$9 AND usuario_id=$10
       RETURNING *`,
      [descricao, parseFloat(valor), categoria_id || null, conta_id || null,
       data_vencimento || null, dataPag, isPago, fixo,
       req.params.id, req.usuarioId]
    );

    // Ajusta saldo da conta
    if (original.conta_id) {
      const sinalOld = original.tipo === 'receita' ? 1 : -1;
      const sinalNew = original.tipo === 'receita' ? 1 : -1;
      const diff = (isPago ? sinalNew * parseFloat(valor) : 0)
                 - (original.pago ? sinalOld * parseFloat(original.valor) : 0);
      if (diff !== 0) {
        await db.query(
          'UPDATE contas SET saldo = saldo + $1 WHERE id = $2 AND usuario_id = $3',
          [diff, original.conta_id, req.usuarioId]
        );
      }
    }

    res.json({ ...rows[0], data_transacao: rows[0].data_pagamento || rows[0].data_vencimento });
  } catch (err) {
    console.error('Erro atualizar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/transactions/:id ─────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2 RETURNING *',
      [req.params.id, req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Transação não encontrada' });

    const t = rows[0];
    if (t.pago && t.conta_id) {
      const sinal = t.tipo === 'receita' ? -1 : 1;
      await db.query(
        'UPDATE contas SET saldo = saldo + $1 WHERE id = $2 AND usuario_id = $3',
        [sinal * parseFloat(t.valor), t.conta_id, req.usuarioId]
      );
    }

    res.json({ mensagem: 'Transação removida com sucesso' });
  } catch (err) {
    console.error('Erro deletar transação:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/transactions/contas ─────────────────────────────
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

// ── GET /api/transactions/categorias ────────────────────────
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
