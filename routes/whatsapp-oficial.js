// routes/whatsapp-oficial.js — Webhook da API Oficial do WhatsApp (Meta)

const express = require('express');
const router = express.Router();
const axios = require('axios');

const VERIFY_TOKEN = process.env.WA_OFICIAL_VERIFY_TOKEN || 'secretario_webhook_2026';
const ACCESS_TOKEN = process.env.WA_OFICIAL_ACCESS_TOKEN; // token permanente da Meta
const PHONE_NUMBER_ID = process.env.WA_OFICIAL_PHONE_ID;  // ex: 1108710102325259

// ── GET /webhook/whatsapp — Verificação da Meta ──────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Meta verificado com sucesso!');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Webhook Meta: token inválido');
  res.sendStatus(403);
});

// ── POST /webhook/whatsapp — Receber mensagens dos clientes ──
router.post('/', async (req, res) => {
  // Responde 200 imediatamente para a Meta não reenviar
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return; // não é mensagem (pode ser status de entrega, etc)

    const from = message.from;           // número do cliente ex: 5511999999999
    const type = message.type;           // text, audio, image, etc

    let texto = '';

    if (type === 'text') {
      texto = message.text?.body || '';
    } else if (type === 'audio') {
      // futuramente: transcrever áudio
      texto = '[áudio]';
    } else if (type === 'image') {
      texto = '[imagem]';
    }

    console.log(`📲 [META] Mensagem de +${from}: ${texto}`);

    // ─── Aqui você chama sua lógica de IA igual ao Baileys ───
    // Exemplo: await processarMensagemOficial(from, texto);

    // Por enquanto, responde confirmando o recebimento
    await enviarMensagem(from, `Recebi sua mensagem: "${texto}"\n\n(Bot oficial em configuração)`);

  } catch (err) {
    console.error('❌ [META] Erro ao processar webhook:', err.message);
  }
});

// ── Função auxiliar: enviar mensagem via API Meta ────────────
async function enviarMensagem(para, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: para,
        type: 'text',
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('❌ [META] Erro ao enviar mensagem:', err.response?.data || err.message);
  }
}

module.exports = router;
module.exports.enviarMensagem = enviarMensagem;
