// utils/gcal.js — Sincronização com Google Calendar por usuário
// Uso: const gcal = require('../utils/gcal');
//      await gcal.criarEvento(usuarioId, { titulo, dataHora, lembrarAntes, local, notas });
//      await gcal.cancelarEvento(usuarioId, googleEventId);

const { google } = require('googleapis');
const db = require('../database/db');

// ── Carrega credenciais globais do admin ─────────────────────────────────────
async function _carregarCredenciais() {
  const { rows } = await db.query(
    `SELECT chave, valor FROM configuracoes
     WHERE chave IN ('google_cal_email','google_cal_private_key')`
  );
  if (rows.length < 2) return null;

  const serviceEmail  = rows.find(r => r.chave === 'google_cal_email')?.valor;
  const privateKeyRaw = rows.find(r => r.chave === 'google_cal_private_key')?.valor;
  const privateKey    = privateKeyRaw?.replace(/\\n/g, '\n');

  if (!serviceEmail || !privateKey) return null;
  return { serviceEmail, privateKey };
}

// ── Retorna cliente autenticado + calendarId do usuário ──────────────────────
async function _clienteDoUsuario(usuarioId) {
  // 1. calendar_id do usuário
  const uRes = await db.query(
    'SELECT google_calendar_id FROM usuarios WHERE id = $1',
    [usuarioId]
  );
  const calendarId = uRes.rows[0]?.google_calendar_id;
  if (!calendarId) return null; // usuário não configurou

  // 2. credenciais globais
  const creds = await _carregarCredenciais();
  if (!creds) return null; // admin não configurou

  const auth = new google.auth.JWT(
    creds.serviceEmail,
    null,
    creds.privateKey,
    ['https://www.googleapis.com/auth/calendar']
  );
  const calendar = google.calendar({ version: 'v3', auth });

  return { calendar, calendarId };
}

// ── Cria evento no Google Calendar ──────────────────────────────────────────
// Retorna o google_event_id (string) ou null se integração não configurada
async function criarEvento(usuarioId, { titulo, dataHora, lembrarAntes = 30, local = null, notas = null }) {
  try {
    const cliente = await _clienteDoUsuario(usuarioId);
    if (!cliente) return null;

    const { calendar, calendarId } = cliente;

    // dataHora já é um objeto Date (ISO) vindo do banco/handler
    const inicio = new Date(dataHora);
    const fim    = new Date(inicio.getTime() + 60 * 60 * 1000); // +1h por padrão

    const evento = {
      summary:     titulo,
      location:    local    || undefined,
      description: notas    || undefined,
      start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: lembrarAntes }],
      },
    };

    const res = await calendar.events.insert({ calendarId, requestBody: evento });
    const eventId = res.data.id;
    console.log(`📅 GCal: evento criado para usuario ${usuarioId} → ${eventId}`);
    return eventId;
  } catch (err) {
    // Não quebra o fluxo principal — só loga
    console.warn(`⚠️  GCal criarEvento falhou (usuario ${usuarioId}):`, err.message);
    return null;
  }
}

// ── Cancela/exclui evento no Google Calendar ─────────────────────────────────
// googleEventId é o id retornado por criarEvento e salvo na coluna google_event_id
async function cancelarEvento(usuarioId, googleEventId) {
  if (!googleEventId) return;
  try {
    const cliente = await _clienteDoUsuario(usuarioId);
    if (!cliente) return;

    const { calendar, calendarId } = cliente;
    await calendar.events.delete({ calendarId, eventId: googleEventId });
    console.log(`📅 GCal: evento removido para usuario ${usuarioId} → ${googleEventId}`);
  } catch (err) {
    if (err.code === 410) return; // já deletado no Google
    console.warn(`⚠️  GCal cancelarEvento falhou (usuario ${usuarioId}):`, err.message);
  }
}

module.exports = { criarEvento, cancelarEvento };