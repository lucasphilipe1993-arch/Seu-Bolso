// utils/gcal.js — Sincronização com Google Calendar via OAuth por usuário
// Cada usuário conecta sua própria conta Google. O token OAuth é salvo
// na tabela `usuarios` (colunas: gcal_access_token, gcal_refresh_token,
// gcal_token_expiry). O calendário usado é sempre o primário ("primary").
//
// Uso:
//   const gcal = require('../utils/gcal');
//   await gcal.criarEvento(usuarioId, { titulo, dataHora, lembrarAntes, local, notas });
//   await gcal.cancelarEvento(usuarioId, googleEventId);
//   gcal.gerarUrlOAuth()           → URL para redirecionar o usuário
//   await gcal.trocarCodigo(code)  → { access_token, refresh_token, expiry_date }

const { google } = require('googleapis');
const db = require('../database/db');

// ── Variáveis de ambiente necessárias ────────────────────────────────────────
// GOOGLE_CLIENT_ID     → Client ID do projeto no Google Cloud Console
// GOOGLE_CLIENT_SECRET → Client Secret do projeto
// GOOGLE_REDIRECT_URI  → Ex: https://seusite.com/api/agenda/gcal/callback
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI;

function _criarOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

// ── Garante colunas OAuth na tabela usuarios (idempotente) ───────────────────
async function garantirColunasOAuth() {
  const colunas = [
    'gcal_access_token  TEXT',
    'gcal_refresh_token TEXT',
    'gcal_token_expiry  BIGINT',
    'gcal_email         TEXT',
  ];
  for (const col of colunas) {
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
}
garantirColunasOAuth();

// ── Gera a URL para o usuário autorizar o acesso ─────────────────────────────
function gerarUrlOAuth(state = '') {
  const oAuth2Client = _criarOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',   // garante refresh_token
    prompt:      'consent',   // força a emissão de refresh_token mesmo se já autorizou
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,                    // pode passar usuarioId codificado para o callback
  });
}

// ── Troca o "code" do callback por tokens e salva no banco ───────────────────
async function trocarCodigo(code, usuarioId) {
  const oAuth2Client = _criarOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);
  // tokens: { access_token, refresh_token, expiry_date, id_token, ... }

  // Extrai email do id_token (JWT) — sem chamada extra à API
  let email = null;
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
      );
      email = payload.email || null;
    } catch { /* ignora */ }
  }

  await db.query(
    `UPDATE usuarios
     SET gcal_access_token  = $1,
         gcal_refresh_token = $2,
         gcal_token_expiry  = $3,
         gcal_email         = $4
     WHERE id = $5`,
    [
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date   || null,
      email,
      usuarioId,
    ]
  );

  return { email, tokens };
}

// ── Remove tokens OAuth do usuário (desconectar) ─────────────────────────────
async function desconectar(usuarioId) {
  await db.query(
    `UPDATE usuarios
     SET gcal_access_token  = NULL,
         gcal_refresh_token = NULL,
         gcal_token_expiry  = NULL,
         gcal_email         = NULL
     WHERE id = $1`,
    [usuarioId]
  );
}

// ── Retorna cliente OAuth autenticado e pronto para usar ─────────────────────
async function _clienteAutenticado(usuarioId) {
  const { rows } = await db.query(
    'SELECT gcal_access_token, gcal_refresh_token, gcal_token_expiry FROM usuarios WHERE id = $1',
    [usuarioId]
  );
  const u = rows[0];
  if (!u?.gcal_access_token) return null; // usuário não conectou o Google

  const oAuth2Client = _criarOAuthClient();
  oAuth2Client.setCredentials({
    access_token:  u.gcal_access_token,
    refresh_token: u.gcal_refresh_token,
    expiry_date:   u.gcal_token_expiry ? Number(u.gcal_token_expiry) : undefined,
  });

  // Renova o access_token automaticamente se expirado
  oAuth2Client.on('tokens', async (novosTokens) => {
    const updates = [];
    const vals    = [];
    if (novosTokens.access_token) {
      updates.push(`gcal_access_token = $${updates.length + 1}`);
      vals.push(novosTokens.access_token);
    }
    if (novosTokens.expiry_date) {
      updates.push(`gcal_token_expiry = $${updates.length + 1}`);
      vals.push(novosTokens.expiry_date);
    }
    if (novosTokens.refresh_token) {
      updates.push(`gcal_refresh_token = $${updates.length + 1}`);
      vals.push(novosTokens.refresh_token);
    }
    if (updates.length > 0) {
      vals.push(usuarioId);
      await db.query(
        `UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${vals.length}`,
        vals
      ).catch(e => console.warn('⚠️  Falha ao salvar tokens renovados:', e.message));
    }
  });

  return oAuth2Client;
}

// ── Cria evento no Google Calendar primário do usuário ───────────────────────
// Retorna o google_event_id (string) ou null se integração não configurada
async function criarEvento(usuarioId, { titulo, dataHora, lembrarAntes = 30, local = null, notas = null }) {
  try {
    const auth = await _clienteAutenticado(usuarioId);
    if (!auth) return null;

    const calendar = google.calendar({ version: 'v3', auth });

    const inicio = new Date(dataHora);
    const fim    = new Date(inicio.getTime() + 60 * 60 * 1000); // +1h

    const evento = {
      summary:     titulo,
      location:    local  || undefined,
      description: notas  || undefined,
      start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' },
      reminders: {
        useDefault: false,
        overrides:  [{ method: 'popup', minutes: lembrarAntes }],
      },
    };

    const res     = await calendar.events.insert({ calendarId: 'primary', requestBody: evento });
    const eventId = res.data.id;
    console.log(`📅 GCal: evento criado para usuario ${usuarioId} → ${eventId}`);
    return eventId;
  } catch (err) {
    console.warn(`⚠️  GCal criarEvento falhou (usuario ${usuarioId}):`, err.message);
    return null;
  }
}

// ── Cancela/exclui evento no Google Calendar ─────────────────────────────────
async function cancelarEvento(usuarioId, googleEventId) {
  if (!googleEventId) return;
  try {
    const auth = await _clienteAutenticado(usuarioId);
    if (!auth) return;

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId: googleEventId });
    console.log(`📅 GCal: evento removido para usuario ${usuarioId} → ${googleEventId}`);
  } catch (err) {
    if (err.code === 410) return; // já deletado no Google
    console.warn(`⚠️  GCal cancelarEvento falhou (usuario ${usuarioId}):`, err.message);
  }
}

// ── Testa a conexão do usuário (lista 1 evento do calendário primário) ────────
async function testarConexao(usuarioId) {
  const auth = await _clienteAutenticado(usuarioId);
  if (!auth) throw new Error('Google Calendar não conectado. Faça a autorização primeiro.');

  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.list({ calendarId: 'primary', maxResults: 1 });
  // Se não lançar erro, a conexão está ok
}

module.exports = { gerarUrlOAuth, trocarCodigo, desconectar, criarEvento, cancelarEvento, testarConexao };
