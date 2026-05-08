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
const dividasRoute      = require('./routes/dividas'); // ← ADICIONADO

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
app.use('/api/dividas',      dividasRoute);      // ← ADICIONADO

// ─── Rotas de resumo/categorias (usadas pelo dashboard) ──────
const autenticar = require('./middleware/auth');

app.get('/api/resumo', autenticar, async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END), 0) AS receita_total,
         COALESCE(SUM(CASE WHEN tipo = 'despesa' THEN valor ELSE 0 END), 0) AS despesa_total
       FROM transacoes
       WHERE usuario_id = $1
         AND EXTRACT(MONTH FROM data_transacao) = $2
         AND EXTRACT(YEAR  FROM data_transacao) = $3`,
      [req.usuarioId, mes, ano]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro /api/resumo:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.get('/api/categorias-resumo', autenticar, async (req, res) => {
  try {
    const mes = parseInt(req.query.mes) || new Date().getMonth() + 1;
    const ano = parseInt(req.query.ano) || new Date().getFullYear();

    const { rows } = await db.query(
      `SELECT
         COALESCE(c.nome, 'Outros') AS categoria,
         SUM(t.valor) AS total
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND EXTRACT(MONTH FROM t.data_transacao) = $2
         AND EXTRACT(YEAR  FROM t.data_transacao) = $3
       GROUP BY c.nome
       ORDER BY total DESC`,
      [req.usuarioId, mes, ano]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro /api/categorias-resumo:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({ ok: true, bot: bot.conectado, ts: new Date().toISOString() })
);

// ─── Fallback → index.html (APENAS para rotas não-API) ───────
// IMPORTANTE: sem esse filtro, erros de API retornavam HTML
// causando "Unexpected token '<'" no frontend
app.get('*', (req, res) => {
  // Se for chamada de API sem rota, retorna JSON de erro
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erro: `Rota não encontrada: ${req.path}` });
  }

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
