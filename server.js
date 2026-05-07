// server.js — Ponto de entrada principal do GranaZen
// Inicia Express + PostgreSQL + Bot WhatsApp
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const db = require('./database/db');

const authRoutes = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const { router: whatsappRouter, setBotInstance } = require('./routes/whatsapp');

const app = express();

// ── Middlewares globais ───────────────────────────────────
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.APP_URL].filter(Boolean)
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Servir arquivos estáticos (seu front-end) ────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Rotas da API ─────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/whatsapp',     whatsappRouter);

// ── Rota de saúde (Railway usa para health check) ────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── SPA fallback: tudo que não é API serve o index ───────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ erro: 'Rota não encontrada' });
  }
  // Se a rota for /dashboard, serve dashboard.html
  if (req.path.startsWith('/dashboard')) {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Inicia o servidor ────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 GranaZen rodando em http://localhost:${PORT}`);
  console.log(`📁 Ambiente: ${process.env.NODE_ENV || 'development'}\n`);
});

// ── Inicia o Bot WhatsApp (Baileys) ──────────────────────
// Executa em background sem travar o servidor
const BotGranaZen = require('./bot/handler');
const bot = new BotGranaZen();

bot.iniciar()
  .then(() => {
    setBotInstance(bot);
    console.log('🤖 Bot WhatsApp inicializado');
  })
  .catch((err) => {
    console.error('⚠️  Bot WhatsApp falhou ao iniciar:', err.message);
    console.error('   O servidor continua funcionando sem o bot.');
  });

// Impede que erros não tratados derrubem o servidor
process.on('uncaughtException', (err) => {
  console.error('⚠️  Erro não tratado (bot):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promise rejeitada (bot):', reason);
});

// ── Cron: lembretes diários às 8h ────────────────────────
// Envia WhatsApp para quem tem contas vencendo hoje
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Executando lembretes diários...');
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.telefone, u.nome, u.whatsapp_ativo
       FROM transacoes t
       JOIN usuarios u ON u.id = t.usuario_id
       WHERE t.data_vencimento = CURRENT_DATE
         AND t.pago = false
         AND u.whatsapp_ativo = true
         AND u.telefone IS NOT NULL`
    );

    for (const t of rows) {
      const valorFmt = parseFloat(t.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      await bot.enviar(
        t.telefone,
        `🔔 *Lembrete GranaZen*\n\nVence *hoje*: ${t.descricao}\n💵 ${valorFmt}\n\nNão esqueça de pagar! Acesse: ${process.env.APP_URL}`
      );
    }

    if (rows.length > 0) console.log(`  ✅ ${rows.length} lembrete(s) enviado(s)`);
  } catch (err) {
    console.error('Erro nos lembretes:', err.message);
  }
}, { timezone: 'America/Sao_Paulo' });
