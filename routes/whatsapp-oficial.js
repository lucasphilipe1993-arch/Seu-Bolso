// routes/whatsapp-oficial.js
// ─────────────────────────────────────────────────────────────────────────────
// Webhook da API Oficial do WhatsApp (Meta)
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const router     = express.Router();
const BotOficial = require('../bot/handler-oficial');

const VERIFY_TOKEN = process.env.WA_OFICIAL_VERIFY_TOKEN || 'secretario_webhook_2026';

// Instância única do bot oficial
const botOficial = new BotOficial();

// Inicia o loop de lembretes (independente do bot Baileys)
botOficial.iniciarLembretes();

// ── GET /webhook/whatsapp — Verificação da Meta ───────────────────────────────
router.get('/', (req, res) => {
  // LOG DE DEBUG — mostra exatamente o que a Meta está enviando
  console.log('[META] GET params:', JSON.stringify(req.query));

  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // ✅ Verificação real da Meta
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ [META] Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }

  // ✅ Health check sem parâmetros — responde 200 silenciosamente
  if (!mode && !token) {
    return res.sendStatus(200);
  }

  // ❌ Token ou mode inválido — loga detalhes para debug
  console.warn('[META] Verificação falhou | mode:', mode, '| token:', token, '| VERIFY_TOKEN:', VERIFY_TOKEN);
  res.sendStatus(403);
});

// ── POST /webhook/whatsapp — Receber eventos da Meta ─────────────────────────
router.post('/', async (req, res) => {
  // ⚠️ CRÍTICO: responde 200 IMEDIATAMENTE
  // A Meta considera falha se não receber 200 em 20s e vai reenviar
  res.sendStatus(200);

  // Processa em background
  botOficial.processarWebhook(req.body).catch(err => {
    console.error('[META] Erro não capturado no webhook:', err.message);
  });
});

module.exports = router;
module.exports.botOficial = botOficial;
