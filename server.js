global.crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const db = require('./database/db');
const BotGranaZen = require('./bot/handler');

// Rotas
const authRoutes       = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const whatsappRoute    = require('./routes/whatsapp');
const adminRoute       = require('./routes/admin');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const bot  = new BotGranaZen();

// Injeta a instância do bot nas rotas
whatsappRoute.setBotInstance(bot);
adminRoute.setBotInstance(bot);
authRoutes.setBotInstance(bot);

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const DASHBOARD_PATH = path.join(__dirname, 'public');
app.use(express.static(DASHBOARD_PATH));

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📡 Dashboard conectado via socket:', socket.id);

  socket.emit('status', { status: bot.conectado ? 'connected' : 'disconnected' });

  if (bot.qrAtual) {
    QRCode.toDataURL(bot.qrAtual)
      .then(url => socket.emit('qr', { url }))
      .catch(() => {});
  }

  socket.on('disconnect', () => {
    console.log('📡 Dashboard desconectado:', socket.id);
  });
});

// ─── Eventos do bot → Socket ──────────────────────────────────
bot.onQR = async (qr) => {
  try {
    const url = await QRCode.toDataURL(qr);
    io.emit('qr',     { url });
    io.emit('status', { status: 'qr' });
  } catch {}
};

bot.onConnected = async () => {
  io.emit('status',  { status: 'connected' });
  io.emit('qr_clear');

  try {
    const creds = bot.socket?.authState?.creds;
    const jid   = creds?.me?.id || null;
    if (jid) {
      const numero = jid.replace(/:\d+/, '').replace('@s.whatsapp.net', '');
      io.emit('numero', { numero });
      console.log(`📱 Número conectado: ${numero}`);
    }
  } catch {}
};

bot.onDisconnected = () => {
  io.emit('status', { status: 'disconnected' });
};

bot.onNovaTransacao = (data) => {
  io.emit('nova_transacao', data);
};

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/whatsapp',     whatsappRoute.router);
app.use('/api/admin',        adminRoute.router);

// Health check
app.get('/health', (req, res) =>
  res.json({ ok: true, bot: bot.conectado, ts: new Date().toISOString() })
);

// ─── ROTA TEMPORÁRIA DE CORREÇÃO — REMOVER DEPOIS ─────────────
app.get('/fix-sessao', async (req, res) => {
  try {
    // Remove sessões antigas/erradas do usuário antigo
    const d1 = await db.query(`DELETE FROM sessoes_bot WHERE usuario_id = '6fb7e398-73c2-4af8-8111-5b5d6a4f37ff'`);
    // Remove qualquer sessão duplicada com o telefone
    const d2 = await db.query(`DELETE FROM sessoes_bot WHERE telefone = '31991003333'`);
    // Remove cache de LID antigo
    await db.query(`DELETE FROM lid_map WHERE telefone = '31991003333'`).catch(() => {});
    // Insere sessão correta
    await db.query(`INSERT INTO sessoes_bot (usuario_id, telefone) VALUES ('eff03320-19f5-4949-a3a6-c780145f6659', '31991003333')`);
    // Confirma
    const r = await db.query(`SELECT telefone, usuario_id, estado FROM sessoes_bot WHERE telefone = '31991003333'`);
    // Limpa cache em memória do bot
    if (bot.lidCache) bot.lidCache.clear();
    res.json({
      ok: true,
      deletados_usuario_antigo: d1.rowCount,
      deletados_telefone: d2.rowCount,
      sessao_criada: r.rows,
    });
  } catch(e) {
    res.json({ erro: e.message });
  }
});
// ─────────────────────────────────────────────────────────────

// Fallback → index.html
app.get('*', (req, res) => {
  const { existsSync } = require('fs');
  const index = path.join(DASHBOARD_PATH, 'index.html');
  if (existsSync(index)) return res.sendFile(index);
  res.json({ message: 'Seu Bolso API', conectado: bot.conectado });
});

// ─── Encerramento limpo ───────────────────────────────────────
let encerrando = false;
async function encerrarLimpo(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n🛑 Sinal ${sinal} recebido. Encerrando...`);
  try {
    await bot._fecharSocket();
    console.log('✅ Socket WhatsApp fechado.');
  } catch (err) {
    console.warn('⚠️  Erro ao fechar socket:', err.message);
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => encerrarLimpo('SIGTERM'));
process.on('SIGINT',  () => encerrarLimpo('SIGINT'));

// ─── Start ────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   💰 Seu Bolso — Iniciado!            ║
║   Porta: ${PORT}                      ║
║   Dashboard: http://localhost:${PORT} ║
╚═══════════════════════════════════════╝
  `);

  if (process.env.AUTO_CONNECT === 'true') {
    const delay = parseInt(process.env.WA_START_DELAY_MS || '5000', 10);
    console.log(`🔄 Auto-conectando WhatsApp em ${delay / 1000}s...`);
    setTimeout(() => bot.iniciar().catch(console.error), delay);
  }
});
