// server.js — servidor principal GranaZen
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
const authRoutes = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const whatsappRoute = require('./routes/whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const bot = new BotGranaZen();

// Injeta a instância do bot na rota de whatsapp
whatsappRoute.setBotInstance(bot);

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Serve o dashboard HTML estático
const DASHBOARD_PATH = path.join(__dirname, 'public');
app.use(express.static(DASHBOARD_PATH));

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📡 Dashboard conectado via socket');

  socket.emit('status', { status: bot.conectado ? 'connected' : 'disconnected' });

  if (bot.qrAtual) {
    QRCode.toDataURL(bot.qrAtual)
      .then(url => socket.emit('qr', { url }))
      .catch(() => {});
  }

  socket.on('disconnect', () => console.log('📡 Dashboard desconectado'));
});

// Repassa eventos do bot para o dashboard via socket
bot.onQR = async (qr) => {
  try {
    const url = await QRCode.toDataURL(qr);
    io.emit('qr', { url });
    io.emit('status', { status: 'qr' });
  } catch {}
};

bot.onConnected = () => {
  io.emit('status', { status: 'connected' });
  io.emit('qr_clear');
};

bot.onDisconnected = () => {
  io.emit('status', { status: 'disconnected' });
};

bot.onNovaTransacao = (data) => {
  io.emit('nova_transacao', data);
};

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/whatsapp', whatsappRoute.router);

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Fallback → dashboard
app.get('*', (req, res) => {
  const index = path.join(DASHBOARD_PATH, 'index.html');
  const { existsSync } = require('fs');
  if (existsSync(index)) return res.sendFile(index);
  res.json({ message: 'GranaZen Bot API', conectado: bot.conectado });
});

// ─── Start ────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════╗
║   💚 GranaZen Bot — Iniciado!        ║
║   Porta: ${PORT}                         ║
║   Dashboard: http://localhost:${PORT}   ║
╚══════════════════════════════════════╝
  `);

  // Inicia o bot automaticamente se AUTO_CONNECT=true
  if (process.env.AUTO_CONNECT === 'true') {
    console.log('🔄 Auto-conectando WhatsApp...');
    bot.iniciar().catch(console.error);
  }
});
