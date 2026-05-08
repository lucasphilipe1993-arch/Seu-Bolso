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
const authRoutes        = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const whatsappRoute     = require('./routes/whatsapp');
const adminRoute        = require('./routes/admin');
const dividasRoute      = require('./routes/dividas');
const stripeRoute       = require('./routes/stripe'); // ← STRIPE
const cuponsRoute       = require('./routes/cupons'); // ← CUPONS

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

// ─── Redirecionamento: seusecretario.com.br → www ────────────
app.use((req, res, next) => {
  if (req.headers.host === 'seusecretario.com.br') {
    return res.redirect(301, 'https://www.seusecretario.com.br' + req.url);
  }
  next();
});

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// ⚠️ IMPORTANTE: o webhook do Stripe precisa do body RAW,
// então registramos ANTES do express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

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
app.use('/api/dividas',      dividasRoute);
app.use('/api/stripe',       stripeRoute); // ← STRIPE
app.use('/api/cupons',       cuponsRoute); // ← CUPONS

// ─── Atalho /api/me → /api/auth/me ───────────────────────────
const autenticar = require('./middleware/auth');
app.get('/api/me', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nome, sobrenome, email, telefone, plano, whatsapp_ativo, criado_em
       FROM usuarios WHERE id = $1`,
      [req.usuarioId]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ ok: true, bot: bot.conectado, ts: new Date().toISOString() })
);

// ─── Fallback ─────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erro: `Rota não encontrada: ${req.path}` });
  }
  next();
});

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
║   💰 Seu Secretário — Iniciado!            ║
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
