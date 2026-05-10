// routes/whatsapp.js — Endpoints para gerenciar o bot WhatsApp
const express = require('express');
const router = express.Router();
const autenticar = require('../middleware/auth');
const db = require('../database/db');

// Referência ao bot (injetada pelo server.js)
let botInstance = null;
module.exports.setBotInstance = (bot) => { botInstance = bot; };

// ── GET /api/whatsapp/status ─────────────────────────────
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
router.post('/vincular', autenticar, async (req, res) => {
  let { telefone } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'Telefone obrigatório' });

  // Normaliza o número
  telefone = telefone.replace(/\D/g, '');
  if (telefone.startsWith('55') && telefone.length > 11) {
    telefone = telefone.slice(2);
  }
  if (telefone.length === 10) {
    const ddd = telefone.slice(0, 2);
    const numero = telefone.slice(2);
    if (['6', '7', '8', '9'].includes(numero[0])) {
      telefone = ddd + '9' + numero;
    }
  }

  try {
    // Remove LID antigo para evitar conflito no recadastro
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

    // Atualiza telefone do usuário
    await db.query(
      'UPDATE usuarios SET telefone = $1, whatsapp_ativo = true WHERE id = $2',
      [telefone, req.usuarioId]
    );

    // Cria ou atualiza sessão do bot
    await db.query(
      `INSERT INTO sessoes_bot (telefone, usuario_id)
       VALUES ($1, $2)
       ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2, lid = NULL`,
      [telefone, req.usuarioId]
    );

    res.json({ mensagem: 'WhatsApp vinculado com sucesso' });

    // ─── Dispara boas-vindas em background para capturar o LID ───
    // Aguarda 3s para garantir que o banco já foi commitado
    setTimeout(() => _enviarBoasVindas(telefone, req.usuarioId), 3000);

  } catch (err) {
    console.error('Erro ao vincular WhatsApp:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── Envia mensagem de boas-vindas e captura LID automaticamente ──
async function _enviarBoasVindas(telefone, usuarioId) {
  if (!botInstance || !botInstance.conectado) {
    console.log(`⚠️  Bot desconectado — boas-vindas não enviadas para ${telefone}`);
    return;
  }

  try {
    // Busca nome do usuário
    const { rows } = await db.query(
      'SELECT nome FROM usuarios WHERE id = $1',
      [usuarioId]
    );
    const nome = rows[0]?.nome || 'cliente';

    // Formata o JID do WhatsApp
    const jid = `55${telefone}@s.whatsapp.net`;

    const mensagem = `Olá, ${nome}! 👋\n\nSeu WhatsApp foi vinculado com sucesso ao *Seu Secretário*! 🎉\n\nAgora você pode me enviar suas receitas, despesas e compromissos aqui pelo WhatsApp. Estou aqui para te ajudar a organizar suas finanças!\n\nDigite *ajuda* para ver o que eu consigo fazer por você. 😊`;

    await botInstance.socket.sendMessage(jid, { text: mensagem });
    console.log(`✅ Boas-vindas enviadas para ${telefone} (${nome})`);

    // O Baileys ao enviar a mensagem já vai ter resolvido o LID internamente.
    // Aguarda um pouco e tenta capturar o LID via onWhatsApp
    setTimeout(async () => {
      try {
        const [result] = await botInstance.socket.onWhatsApp(jid);
        if (result?.jid && result.jid.endsWith('@lid')) {
          const lidCapturado = result.jid;
          await db.query(
            `INSERT INTO lid_map (lid, telefone)
             VALUES ($1, $2)
             ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
            [lidCapturado, telefone]
          );
          await db.query(
            `UPDATE sessoes_bot SET lid = $1 WHERE usuario_id = $2`,
            [lidCapturado, usuarioId]
          );
          // Atualiza cache em memória se disponível
          if (botInstance.lidCache) {
            botInstance.lidCache.set(lidCapturado, telefone);
          }
          console.log(`🔖 LID capturado automaticamente: ${lidCapturado} → ${telefone}`);
        }
      } catch {
        // onWhatsApp não suporta LID — o LID será capturado na primeira mensagem recebida
        console.log(`ℹ️  LID será capturado quando ${telefone} responder`);
      }
    }, 5000);

  } catch (err) {
    console.error(`❌ Erro ao enviar boas-vindas para ${telefone}:`, err.message);
  }
}

module.exports.router = router;
