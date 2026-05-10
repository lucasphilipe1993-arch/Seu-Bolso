// routes/whatsapp-oficial.js
// ─────────────────────────────────────────────────────────────────────────────
// Webhook da API Oficial do WhatsApp (Meta)
// Substitui o arquivo anterior — agora delega toda lógica ao BotOficial.
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const BotOficial = require('../bot/handler-oficial');

const VERIFY_TOKEN = process.env.WA_OFICIAL_VERIFY_TOKEN || 'secretario_webhook_2026';

// Instância única do bot oficial (criada uma vez, reutilizada em todos os requests)
const botOficial = new BotOficial();

// Inicia o loop de lembretes assim que a rota for carregada
// (independente do bot Baileys — cada um cuida dos próprios compromissos)
botOficial.iniciarLembretes();

// ── GET /webhook/whatsapp — Verificação da Meta ───────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ [META] Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }

  console.warn('❌ [META] Webhook: token inválido —', token);
  res.sendStatus(403);
});

// ── POST /webhook/whatsapp — Receber eventos da Meta ─────────────────────────
router.post('/', async (req, res) => {
  // ⚠️ CRÍTICO: responde 200 IMEDIATAMENTE antes de qualquer processamento.
  // A Meta considera o webhook com falha se não receber 200 em 20s e vai reenviar.
  res.sendStatus(200);

  // Processa em background (não bloqueia a resposta)
  botOficial.processarWebhook(req.body).catch(err => {
    console.error('[META] Erro não capturado no webhook:', err.message);
  });
});

// ── Exporta o router e a instância do bot (para uso no server.js se necessário)
module.exports = router;
module.exports.botOficial = botOficial;
