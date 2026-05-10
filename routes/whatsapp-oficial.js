const express    = require('express');
const router     = express.Router();
const BotOficial = require('../bot/handler-oficial');

const VERIFY_TOKEN = process.env.WA_OFICIAL_VERIFY_TOKEN || 'secretario_webhook_2026';

const botOficial = new BotOficial();
botOficial.iniciarLembretes();

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ [META] Webhook verificado com sucesso!');
    return res.status(200).send(challenge);
  }

  if (!mode) {
    return res.sendStatus(200);
  }

  console.warn('[META] Verificação falhou | mode:', mode, '| token:', token);
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  res.sendStatus(200);
  botOficial.processarWebhook(req.body).catch(err => {
    console.error('[META] Erro não capturado no webhook:', err.message);
  });
});

module.exports = router;
module.exports.botOficial = botOficial;
