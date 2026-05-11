global.crypto = require('crypto');
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const db = require('./database/db');

// Rotas
const authRoutes           = require('./routes/auth');
const transactionRoutes    = require('./routes/transactions');
const adminRoute           = require('./routes/admin');
const dividasRoute         = require('./routes/dividas');
const stripeRoute          = require('./routes/stripe');
const cuponsRoute          = require('./routes/cupons');
const agendaRouter         = require('./routes/agenda');
const configRoute          = require('./routes/config');
const whatsappOficialRoute = require('./routes/whatsapp-oficial'); // ← META API OFICIAL
const gastosFixosRoute     = require('./routes/gastos-fixos');     // ← GASTOS FIXOS
const limitesRoute         = require('./routes/limites');           // ← LIMITES DE GASTOS

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;

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

// ─── URLs limpas (sem .html) ──────────────────────────────────
app.use((req, res, next) => {
  const { existsSync } = require('fs');
  if (req.path.startsWith('/api/') || req.path.includes('.') || req.path === '/') return next();
  const filePath = path.join(DASHBOARD_PATH, req.path + '.html');
  if (existsSync(filePath)) return res.sendFile(filePath);
  next();
});

app.use(express.static(DASHBOARD_PATH));

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('📡 Dashboard conectado via socket:', socket.id);
  socket.on('disconnect', () => {
    console.log('📡 Dashboard desconectado:', socket.id);
  });
});

// ─── API Routes ───────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/admin',        adminRoute);
app.use('/api/dividas',      dividasRoute);
app.use('/api/stripe',       stripeRoute);
app.use('/api/cupons',       cuponsRoute);
app.use('/api/agenda',       agendaRouter);
app.use('/api/config',       configRoute);
app.use('/api/gcal',         configRoute);
app.use('/api/gastos-fixos', gastosFixosRoute);
app.use('/api/limites',      limitesRoute);

// ─── Webhook API Oficial WhatsApp (Meta) ──────────────────────
app.use('/webhook/whatsapp', whatsappOficialRoute);

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
  res.json({ ok: true, ts: new Date().toISOString() })
);

// ─── Fallback API ─────────────────────────────────────────────
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
  res.json({ message: 'Seu Secretário API' });
});

// ─── Encerramento limpo ───────────────────────────────────────
let encerrando = false;

async function encerrarLimpo(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n🛑 Sinal ${sinal} recebido. Encerrando...`);
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => encerrarLimpo('SIGTERM'));
process.on('SIGINT',  () => encerrarLimpo('SIGINT'));

// ─── Start ────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   💰 Seu Secretário — Iniciado!        ║
║   Porta: ${PORT}                         ║
║   Dashboard: http://localhost:${PORT}    ║
╚═══════════════════════════════════════╝
  `);
});
