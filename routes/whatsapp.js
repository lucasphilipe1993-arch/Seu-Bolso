// routes/whatsapp.js — Endpoints para gerenciar o bot WhatsApp
const express = require('express');
const router = express.Router();
const autenticar = require('../middleware/auth');
const db = require('../database/db');

// Referência ao bot (injetada pelo server.js)
let botInstance = null;
module.exports.setBotInstance = (bot) => { botInstance = bot; };

// ── GET /api/whatsapp/status ─────────────────────────────
// Retorna status da conexão e QR code atual
router.get('/status', autenticar, (req, res) => {
  if (!botInstance) return res.json({ conectado: false, qr: null });
  res.json({
    conectado: botInstance.conectado,
    qr: botInstance.qrAtual || null,
  });
});

// ── POST /api/whatsapp/reconectar ────────────────────────
router.post('/reconectar', autenticar, async (req, res) => {
  if (!botInstance) return res.status(503).json({ erro: 'Bot não iniciado' });
  try {
    await botInstance.reconectar();
    res.json({ mensagem: 'Reconexão iniciada' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── POST /api/whatsapp/vincular ──────────────────────────
// Vincula o telefone autenticado ao bot
router.post('/vincular', autenticar, async (req, res) => {
  let { telefone } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'Telefone obrigatório' });

  // ─── Normaliza o número antes de salvar ───────────────────────
  // Remove tudo que não for dígito
  telefone = telefone.replace(/\D/g, '');
  // Remove DDI 55 se vier junto
  if (telefone.startsWith('55') && telefone.length > 11) {
    telefone = telefone.slice(2);
  }
  // Adiciona o 9º dígito se o número tiver apenas 10 dígitos (celular sem o 9)
  if (telefone.length === 10) {
    const ddd = telefone.slice(0, 2);
    const numero = telefone.slice(2);
    if (['6', '7', '8', '9'].includes(numero[0])) {
      telefone = ddd + '9' + numero;
    }
  }
  // ─────────────────────────────────────────────────────────────

  try {
    await db.query(
      'UPDATE usuarios SET telefone = $1, whatsapp_ativo = true WHERE id = $2',
      [telefone, req.usuarioId]
    );

    // Remove LID antigo do lid_map e da sessão para evitar conflito no recadastro
    await db.query(
      `DELETE FROM lid_map WHERE telefone IN (
         SELECT telefone FROM usuarios WHERE id = $1 AND telefone IS NOT NULL
       )`,
      [req.usuarioId]
    ).catch(() => {});
    await db.query(
      `UPDATE sessoes_bot SET lid = NULL WHERE usuario_id = $1`,
      [req.usuarioId]
    ).catch(() => {});

    // Cria (ou atualiza) a sessão do bot para este número
    await db.query(
      `INSERT INTO sessoes_bot (telefone, usuario_id)
       VALUES ($1, $2)
       ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2, lid = NULL`,
      [telefone, req.usuarioId]
    );

    res.json({ mensagem: 'WhatsApp vinculado com sucesso' });
  } catch (err) {
    console.error('Erro ao vincular WhatsApp:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports.router = router;
