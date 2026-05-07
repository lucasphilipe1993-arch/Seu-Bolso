// routes/admin.js
const express = require('express');
const router = express.Router();
const db = require('../database/db');

let _bot = null;

// Injeta a instância do bot (igual ao whatsapp.js)
function setBotInstance(bot) {
  _bot = bot;
}

// ─── Middleware de autenticação simples ───────────────────────
// Protege todas as rotas admin com um token via env
function autenticar(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  next();
}

router.use(autenticar);

// ─── GET /api/admin/status ────────────────────────────────────
// Retorna status atual do bot
router.get('/status', (req, res) => {
  res.json({
    conectado: _bot?.conectado ?? false,
    tentativas: _bot?._tentativas ?? 0,
    reconectando: _bot?._reconectando ?? false,
    temQR: !!_bot?.qrAtual,
  });
});

// ─── POST /api/admin/reconectar ───────────────────────────────
// Força reconexão do bot
router.post('/reconectar', async (req, res) => {
  if (!_bot) return res.status(500).json({ erro: 'Bot não inicializado' });

  try {
    await _bot.reconectar();
    res.json({ ok: true, mensagem: 'Reconexão iniciada' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── DELETE /api/admin/sessao ─────────────────────────────────
// Apaga a sessão do WhatsApp no banco (resolve erro 440)
router.delete('/sessao', async (req, res) => {
  try {
    await db.query('DELETE FROM whatsapp_session');
    res.json({ ok: true, mensagem: 'Sessão apagada. Reconecte o bot para gerar novo QR.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── DELETE /api/admin/sessao-e-reconectar ────────────────────
// Apaga sessão E já reconecta (one-shot para resolver o erro 440)
router.delete('/sessao-e-reconectar', async (req, res) => {
  if (!_bot) return res.status(500).json({ erro: 'Bot não inicializado' });

  try {
    await db.query('DELETE FROM whatsapp_session');
    // Responde antes de reconectar para não deixar o cliente esperando
    res.json({ ok: true, mensagem: 'Sessão apagada. Reconexão iniciada, aguarde o QR Code.' });
    // Aguarda 1s e reconecta em background
    setTimeout(() => _bot.reconectar().catch(console.error), 1000);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = { router, setBotInstance };
