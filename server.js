/**
 * server.js — Seu Bolso / GranaZen
 * ─────────────────────────────────────────────────────────────────────────────
 * Stack:
 *   • Express  — API REST + servir o dashboard
 *   • better-sqlite3 — banco local SQLite (sem necessidade de Postgres no Railway)
 *   • whatsapp.js   — motor WhatsApp multi-sessão com IA Gemini
 *   • node-cron     — lembretes diários às 8h
 *
 * Variáveis de ambiente necessárias (.env ou Railway → Variables):
 *   PORT          — porta do servidor (Railway injeta automaticamente)
 *   JWT_SECRET    — segredo para assinar tokens JWT (gere um string aleatório)
 *   ADMIN_TOKEN   — token estático para autenticar rotas /api/admin/*
 *                   (se não definido, usa "admin123" — MUDE em produção!)
 *   APP_URL       — URL pública do app (ex: https://seubolso.up.railway.app)
 *   NODE_ENV      — "production" | "development"
 *
 * Instalação das dependências:
 *   npm install express better-sqlite3 bcryptjs jsonwebtoken cors dotenv node-cron
 *   npm install @whiskeysockets/baileys @hapi/boom qrcode pino @google/generative-ai
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const Database = require('better-sqlite3');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

// ── BANCO DE DADOS (SQLite) ───────────────────────────────────────────────────
// No Railway, use um volume persistente montado em /data, ou deixe na raiz do projeto.
// Para persistência no Railway: adicione um Volume em /data nas configurações.
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'granazen.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // WAL melhora concorrência de leitura/escrita
db.pragma('foreign_keys = ON');

console.log(`📦 Banco SQLite: ${DB_PATH}`);

// ── SCHEMA DO BANCO ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    senha_hash  TEXT    NOT NULL,
    telefone    TEXT,
    plano       TEXT    DEFAULT 'gratuito',
    whatsapp_ativo INTEGER DEFAULT 0,
    criado_em   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS contas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome        TEXT    NOT NULL,
    banco       TEXT,
    saldo       REAL    DEFAULT 0,
    ativo       INTEGER DEFAULT 1,
    criado_em   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS categorias (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome        TEXT    NOT NULL,
    icone       TEXT    DEFAULT '📦',
    cor         TEXT    DEFAULT '#6366f1',
    tipo        TEXT    DEFAULT 'despesa'
  );

  CREATE TABLE IF NOT EXISTS transacoes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id       INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    conta_id         INTEGER REFERENCES contas(id) ON DELETE SET NULL,
    categoria_id     INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
    descricao        TEXT    NOT NULL,
    valor            REAL    NOT NULL,
    tipo             TEXT    NOT NULL CHECK(tipo IN ('receita','despesa')),
    data_transacao   TEXT    NOT NULL,
    data_vencimento  TEXT,
    pago             INTEGER DEFAULT 1,
    recorrente       INTEGER DEFAULT 0,
    notas            TEXT,
    criado_em        TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS metas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome        TEXT    NOT NULL,
    valor_alvo  REAL    NOT NULL,
    valor_atual REAL    DEFAULT 0,
    prazo       TEXT,
    status      TEXT    DEFAULT 'ativa',
    criado_em   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS limites (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    categoria_id INTEGER REFERENCES categorias(id) ON DELETE CASCADE,
    valor_limite REAL    NOT NULL,
    mes          TEXT    NOT NULL,
    criado_em    TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_transacoes_usuario ON transacoes(usuario_id, data_transacao DESC);
  CREATE INDEX IF NOT EXISTS idx_transacoes_venc    ON transacoes(data_vencimento, pago);
`);

console.log('✅ Schema do banco aplicado.');

// ── MIDDLEWARE DE AUTENTICAÇÃO JWT ────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'granazen_secret_mude_em_producao';

function authJWT(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// ── MIDDLEWARE DE AUTENTICAÇÃO ADMIN ──────────────────────────────────────────
// Usado pelas rotas do WhatsApp IA (/api/admin/whatsapp/*)
// Aceita: header Authorization: Bearer <ADMIN_TOKEN>  OU  JWT de usuário válido
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin123';

function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });

  // Aceita o token estático de admin
  if (token === ADMIN_TOKEN) return next();

  // Ou um JWT válido de usuário logado
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (_) {}

  return res.status(401).json({ erro: 'Acesso não autorizado' });
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.APP_URL].filter(Boolean)
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir o front-end estático (pasta public/)
app.use(express.static(path.join(__dirname, 'public')));

// ── ROTA DE SAÚDE ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE AUTENTICAÇÃO
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/registro
app.post('/api/auth/registro', (req, res) => {
  const { nome, email, senha, telefone } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'nome, email e senha são obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter ao menos 6 caracteres' });

  const senhaHash = bcrypt.hashSync(senha, 10);
  try {
    const stmt = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, telefone) VALUES (?,?,?,?)');
    const info  = stmt.run(nome, email.toLowerCase().trim(), senhaHash, telefone || null);
    const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ ok: true, token, usuario: { id: info.lastInsertRowid, nome, email } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ erro: 'E-mail já cadastrado' });
    throw e;
  }
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'email e senha são obrigatórios' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email.toLowerCase().trim());
  if (!usuario || !bcrypt.compareSync(senha, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  }
  const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, plano: usuario.plano } });
});

// GET /api/auth/me
app.get('/api/auth/me', authJWT, (req, res) => {
  const usuario = db.prepare('SELECT id, nome, email, telefone, plano, whatsapp_ativo, criado_em FROM usuarios WHERE id = ?').get(req.user.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
  res.json(usuario);
});

// PUT /api/auth/perfil
app.put('/api/auth/perfil', authJWT, (req, res) => {
  const { nome, telefone, whatsapp_ativo } = req.body;
  db.prepare('UPDATE usuarios SET nome=?, telefone=?, whatsapp_ativo=? WHERE id=?')
    .run(nome || '', telefone || null, whatsapp_ativo ? 1 : 0, req.user.id);
  res.json({ ok: true });
});

// PUT /api/auth/senha
app.put('/api/auth/senha', authJWT, (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!senha_atual || !nova_senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
  if (nova_senha.length < 6) return res.status(400).json({ erro: 'Nova senha deve ter ao menos 6 caracteres' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(senha_atual, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'Senha atual incorreta' });
  }
  db.prepare('UPDATE usuarios SET senha_hash=? WHERE id=?').run(bcrypt.hashSync(nova_senha, 10), req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE TRANSAÇÕES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/transactions?mes=2025-05&tipo=despesa&limite=50
app.get('/api/transactions', authJWT, (req, res) => {
  const { mes, tipo, limite = 100, offset = 0 } = req.query;
  let sql = 'SELECT t.*, c.nome AS categoria_nome, c.icone AS categoria_icone FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id WHERE t.usuario_id = ?';
  const params = [req.user.id];
  if (mes) { sql += ' AND strftime(\'%Y-%m\', t.data_transacao) = ?'; params.push(mes); }
  if (tipo) { sql += ' AND t.tipo = ?'; params.push(tipo); }
  sql += ' ORDER BY t.data_transacao DESC LIMIT ? OFFSET ?';
  params.push(Number(limite), Number(offset));
  res.json(db.prepare(sql).all(...params));
});

// POST /api/transactions
app.post('/api/transactions', authJWT, (req, res) => {
  const { descricao, valor, tipo, data_transacao, categoria_id, conta_id, data_vencimento, pago, notas } = req.body;
  if (!descricao || !valor || !tipo || !data_transacao) return res.status(400).json({ erro: 'Campos obrigatórios' });
  const info = db.prepare(
    'INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data_transacao, categoria_id, conta_id, data_vencimento, pago, notas) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, descricao, Number(valor), tipo, data_transacao, categoria_id || null, conta_id || null, data_vencimento || null, pago !== undefined ? (pago ? 1 : 0) : 1, notas || null);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// PUT /api/transactions/:id
app.put('/api/transactions/:id', authJWT, (req, res) => {
  const { descricao, valor, tipo, data_transacao, categoria_id, conta_id, data_vencimento, pago, notas } = req.body;
  const t = db.prepare('SELECT id FROM transacoes WHERE id=? AND usuario_id=?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ erro: 'Transação não encontrada' });
  db.prepare('UPDATE transacoes SET descricao=?, valor=?, tipo=?, data_transacao=?, categoria_id=?, conta_id=?, data_vencimento=?, pago=?, notas=? WHERE id=?')
    .run(descricao, Number(valor), tipo, data_transacao, categoria_id || null, conta_id || null, data_vencimento || null, pago ? 1 : 0, notas || null, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/transactions/:id
app.delete('/api/transactions/:id', authJWT, (req, res) => {
  const info = db.prepare('DELETE FROM transacoes WHERE id=? AND usuario_id=?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ erro: 'Transação não encontrada' });
  res.json({ ok: true });
});

// GET /api/transactions/resumo — totais do mês atual
app.get('/api/transactions/resumo', authJWT, (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  const receita  = db.prepare('SELECT COALESCE(SUM(valor),0) AS total FROM transacoes WHERE usuario_id=? AND tipo=\'receita\' AND strftime(\'%Y-%m\',data_transacao)=?').get(req.user.id, mes);
  const despesa  = db.prepare('SELECT COALESCE(SUM(valor),0) AS total FROM transacoes WHERE usuario_id=? AND tipo=\'despesa\' AND strftime(\'%Y-%m\',data_transacao)=?').get(req.user.id, mes);
  const porCat   = db.prepare(`
    SELECT c.nome, c.icone, SUM(t.valor) AS total
    FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id
    WHERE t.usuario_id=? AND t.tipo='despesa' AND strftime('%Y-%m',t.data_transacao)=?
    GROUP BY t.categoria_id ORDER BY total DESC
  `).all(req.user.id, mes);
  res.json({ receita: receita.total, despesa: despesa.total, saldo: receita.total - despesa.total, por_categoria: porCat });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE CONTAS BANCÁRIAS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/contas', authJWT, (req, res) => {
  res.json(db.prepare('SELECT * FROM contas WHERE usuario_id=? AND ativo=1').all(req.user.id));
});
app.post('/api/contas', authJWT, (req, res) => {
  const { nome, banco, saldo } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  const info = db.prepare('INSERT INTO contas (usuario_id, nome, banco, saldo) VALUES (?,?,?,?)').run(req.user.id, nome, banco || '', saldo || 0);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/contas/:id', authJWT, (req, res) => {
  const { nome, banco, saldo } = req.body;
  db.prepare('UPDATE contas SET nome=?, banco=?, saldo=? WHERE id=? AND usuario_id=?').run(nome, banco || '', saldo || 0, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/contas/:id', authJWT, (req, res) => {
  db.prepare('UPDATE contas SET ativo=0 WHERE id=? AND usuario_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE CATEGORIAS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/categorias', authJWT, (req, res) => {
  res.json(db.prepare('SELECT * FROM categorias WHERE usuario_id=? ORDER BY nome').all(req.user.id));
});
app.post('/api/categorias', authJWT, (req, res) => {
  const { nome, icone, cor, tipo } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  const info = db.prepare('INSERT INTO categorias (usuario_id, nome, icone, cor, tipo) VALUES (?,?,?,?,?)').run(req.user.id, nome, icone || '📦', cor || '#6366f1', tipo || 'despesa');
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/categorias/:id', authJWT, (req, res) => {
  const { nome, icone, cor, tipo } = req.body;
  db.prepare('UPDATE categorias SET nome=?, icone=?, cor=?, tipo=? WHERE id=? AND usuario_id=?').run(nome, icone || '📦', cor || '#6366f1', tipo || 'despesa', req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/categorias/:id', authJWT, (req, res) => {
  db.prepare('DELETE FROM categorias WHERE id=? AND usuario_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE METAS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/metas', authJWT, (req, res) => {
  res.json(db.prepare('SELECT * FROM metas WHERE usuario_id=? ORDER BY criado_em DESC').all(req.user.id));
});
app.post('/api/metas', authJWT, (req, res) => {
  const { nome, valor_alvo, prazo } = req.body;
  if (!nome || !valor_alvo) return res.status(400).json({ erro: 'nome e valor_alvo são obrigatórios' });
  const info = db.prepare('INSERT INTO metas (usuario_id, nome, valor_alvo, prazo) VALUES (?,?,?,?)').run(req.user.id, nome, Number(valor_alvo), prazo || null);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/metas/:id', authJWT, (req, res) => {
  const { nome, valor_alvo, valor_atual, prazo, status } = req.body;
  db.prepare('UPDATE metas SET nome=?, valor_alvo=?, valor_atual=?, prazo=?, status=? WHERE id=? AND usuario_id=?')
    .run(nome, Number(valor_alvo), Number(valor_atual || 0), prazo || null, status || 'ativa', req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/metas/:id', authJWT, (req, res) => {
  db.prepare('DELETE FROM metas WHERE id=? AND usuario_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS DE LIMITES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/limites', authJWT, (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  res.json(db.prepare('SELECT l.*, c.nome AS categoria_nome FROM limites l LEFT JOIN categorias c ON c.id = l.categoria_id WHERE l.usuario_id=? AND l.mes=?').all(req.user.id, mes));
});
app.post('/api/limites', authJWT, (req, res) => {
  const { categoria_id, valor_limite, mes } = req.body;
  if (!categoria_id || !valor_limite) return res.status(400).json({ erro: 'categoria_id e valor_limite são obrigatórios' });
  const mesAlvo = mes || new Date().toISOString().slice(0, 7);
  db.prepare('INSERT INTO limites (usuario_id, categoria_id, valor_limite, mes) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET valor_limite=excluded.valor_limite')
    .run(req.user.id, categoria_id, Number(valor_limite), mesAlvo);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// WHATSAPP IA — registra todas as rotas /api/admin/whatsapp/* e /api/wa/*
// ══════════════════════════════════════════════════════════════════════════════
const wa = require('./whatsapp');

wa.init(db)
  .then(() => {
    wa.registerRoutes(app, adminAuth);
    console.log('🤖 WhatsApp IA inicializado e rotas registradas.');
  })
  .catch((err) => {
    console.error('⚠️  WhatsApp IA falhou ao iniciar:', err.message);
    console.error('   O servidor continua funcionando sem o bot.');
    // Registra as rotas mesmo assim (retornam erro 503 graciosamente)
    try { wa.registerRoutes(app, adminAuth); } catch (_) {}
  });

// ══════════════════════════════════════════════════════════════════════════════
// SPA FALLBACK — serve o dashboard para qualquer rota não-API
// ══════════════════════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ erro: 'Rota não encontrada' });
  }
  // Rotas autenticadas → dashboard.html
  if (req.path.startsWith('/dashboard') || req.path.startsWith('/app')) {
    const dashFile = path.join(__dirname, 'public', 'dashboard.html');
    if (fs.existsSync(dashFile)) return res.sendFile(dashFile);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// INICIA O SERVIDOR
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log(`📁 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🔑 Admin token: ${ADMIN_TOKEN}`);
  }
  console.log('');
});

// ── CRON: lembretes WhatsApp às 8h (horário de Brasília) ─────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Executando lembretes diários...');
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const rows = db.prepare(`
      SELECT t.*, u.telefone, u.nome, u.whatsapp_ativo
      FROM transacoes t
      JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.data_vencimento = ?
        AND t.pago = 0
        AND u.whatsapp_ativo = 1
        AND u.telefone IS NOT NULL
    `).all(hoje);

    for (const t of rows) {
      const valorFmt = parseFloat(t.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      // Envia pela primeira sessão ativa disponível (ou implemente lógica por usuário)
      try {
        const sessoes = db.prepare("SELECT id FROM wa_sessoes WHERE ativo=1 AND status='conectado' LIMIT 1").all();
        if (sessoes.length) {
          const jid = `${t.telefone.replace(/\D/g, '')}@s.whatsapp.net`;
          await wa.sendMessage(sessoes[0].id, jid,
            `🔔 *Lembrete Seu Bolso*\n\nVence *hoje*: ${t.descricao}\n💵 ${valorFmt}\n\nNão esqueça de pagar! Acesse: ${process.env.APP_URL || ''}`
          );
        }
      } catch (e) {
        console.error(`Erro ao enviar lembrete para ${t.telefone}:`, e.message);
      }
    }

    if (rows.length > 0) console.log(`  ✅ ${rows.length} lembrete(s) enviado(s)`);
  } catch (err) {
    console.error('Erro nos lembretes:', err.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// ── TRATAMENTO DE ERROS GLOBAIS ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('⚠️  Erro não tratado:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promise rejeitada:', reason);
});
