// routes/agenda.js — CRUD de compromissos da agenda
const express    = require('express');
const router     = express.Router();
const db         = require('../database/db');
const autenticar = require('../middleware/auth');
const { google } = require('googleapis');

router.use(autenticar);

// ══════════════════════════════════════════════════════════════════════════════
//  HELPER — Sincronização com Google Calendar
//  Usado tanto pelas rotas da web quanto pelo bot (exportado no final)
// ══════════════════════════════════════════════════════════════════════════════

async function getGoogleAuth() {
  try {
    const { rows } = await db.query(
      `SELECT chave, valor FROM configuracoes
       WHERE chave IN ('google_cal_email','google_cal_private_key')`
    );
    if (!rows || rows.length < 2) return null;
    const serviceEmail  = rows.find(r => r.chave === 'google_cal_email')?.valor;
    const privateKeyRaw = rows.find(r => r.chave === 'google_cal_private_key')?.valor;
    const privateKey    = privateKeyRaw?.replace(/\\n/g, '\n');
    if (!serviceEmail || !privateKey) return null;
    return new google.auth.JWT(
      serviceEmail, null, privateKey,
      ['https://www.googleapis.com/auth/calendar']
    );
  } catch { return null; }
}

async function getCalendarId(usuarioId) {
  try {
    const { rows } = await db.query(
      'SELECT google_calendar_id FROM usuarios WHERE id = $1',
      [usuarioId]
    );
    return rows[0]?.google_calendar_id || null;
  } catch { return null; }
}

async function criarEventoGcal(usuarioId, { titulo, data_hora, local, notas, lembrar_antes }) {
  try {
    const [auth, calId] = await Promise.all([getGoogleAuth(), getCalendarId(usuarioId)]);
    if (!auth || !calId) return null;
    const calendar = google.calendar({ version: 'v3', auth });
    const inicio   = new Date(data_hora);
    const fim      = new Date(inicio.getTime() + 60 * 60 * 1000);
    const res = await calendar.events.insert({
      calendarId: calId,
      resource: {
        summary:     titulo,
        location:    local  || undefined,
        description: notas  || undefined,
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
        end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' },
        reminders: {
          useDefault: false,
          overrides:  [{ method: 'popup', minutes: lembrar_antes || 30 }],
        },
      },
    });
    return res.data.id || null;
  } catch (err) {
    console.error('gcal criarEvento erro:', err.message);
    return null;
  }
}

async function atualizarEventoGcal(usuarioId, gcalEventId, { titulo, data_hora, local, notas, lembrar_antes }) {
  try {
    if (!gcalEventId) return;
    const [auth, calId] = await Promise.all([getGoogleAuth(), getCalendarId(usuarioId)]);
    if (!auth || !calId) return;
    const calendar = google.calendar({ version: 'v3', auth });
    const inicio   = new Date(data_hora);
    const fim      = new Date(inicio.getTime() + 60 * 60 * 1000);
    await calendar.events.patch({
      calendarId: calId,
      eventId:    gcalEventId,
      resource: {
        summary:     titulo,
        location:    local  || undefined,
        description: notas  || undefined,
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
        end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' },
        reminders: {
          useDefault: false,
          overrides:  [{ method: 'popup', minutes: lembrar_antes || 30 }],
        },
      },
    });
  } catch (err) { console.error('gcal atualizarEvento erro:', err.message); }
}

async function cancelarEventoGcal(usuarioId, gcalEventId) {
  try {
    if (!gcalEventId) return;
    const [auth, calId] = await Promise.all([getGoogleAuth(), getCalendarId(usuarioId)]);
    if (!auth || !calId) return;
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: calId, eventId: gcalEventId });
  } catch (err) {
    if (err?.code !== 410) console.error('gcal cancelarEvento erro:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SETUP DE TABELAS
// ══════════════════════════════════════════════════════════════════════════════

async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agenda (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id       UUID NOT NULL,
      titulo           TEXT NOT NULL,
      data_hora        TIMESTAMPTZ NOT NULL,
      lembrar_antes    INT NOT NULL DEFAULT 30,
      local            TEXT,
      notas            TEXT,
      lembrete_enviado BOOLEAN NOT NULL DEFAULT FALSE,
      cancelado        BOOLEAN NOT NULL DEFAULT FALSE,
      id_curto         TEXT,
      origem           TEXT DEFAULT 'web',
      gcal_event_id    TEXT,
      criado_em        TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_usuario ON agenda(usuario_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_data    ON agenda(data_hora)`).catch(() => {});
  await db.query(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS gcal_event_id TEXT`).catch(() => {});
}
garantirTabela();

async function garantirColunaGcal() {
  await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_calendar_id TEXT`).catch(() => {});
}
garantirColunaGcal();

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS — AGENDA
// ══════════════════════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const agora = new Date();
  let condicao = 'cancelado = FALSE AND data_hora >= $2';
  let params   = [req.usuarioId, agora];
  if (status === 'cancelado') { condicao = 'cancelado = TRUE'; params = [req.usuarioId]; }
  else if (status === 'passado') { condicao = 'cancelado = FALSE AND data_hora < $2'; params = [req.usuarioId, agora]; }
  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, lembrar_antes, local, notas,
              lembrete_enviado, cancelado, id_curto, origem, gcal_event_id, criado_em
       FROM agenda
       WHERE usuario_id = $1 AND ${condicao}
       ORDER BY data_hora ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const total = await db.query(
      `SELECT COUNT(*) FROM agenda WHERE usuario_id = $1 AND ${condicao}`, params
    );
    res.json({ compromissos: rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Erro ao listar agenda:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.get('/proximos', async (req, res) => {
  const limit = parseInt(req.query.limit) || 3;
  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, local, notas, id_curto
       FROM agenda
       WHERE usuario_id = $1 AND cancelado = FALSE AND data_hora >= NOW()
       ORDER BY data_hora ASC LIMIT $2`,
      [req.usuarioId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar próximos:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/agenda — cria compromisso e sincroniza no Google Calendar ──────
router.post('/', async (req, res) => {
  const { titulo, data_hora, lembrar_antes = 30, local, notas } = req.body;
  if (!titulo || !data_hora)
    return res.status(400).json({ erro: 'titulo e data_hora são obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO agenda (usuario_id, titulo, data_hora, lembrar_antes, local, notas, origem)
       VALUES ($1, $2, $3, $4, $5, $6, 'web') RETURNING *`,
      [req.usuarioId, titulo, data_hora, lembrar_antes, local || null, notas || null]
    );
    const compromisso = rows[0];
    // Sincroniza com Google Calendar sem bloquear a resposta
    criarEventoGcal(req.usuarioId, compromisso).then(gcalEventId => {
      if (gcalEventId) {
        db.query('UPDATE agenda SET gcal_event_id = $1 WHERE id = $2', [gcalEventId, compromisso.id]).catch(() => {});
      }
    });
    res.status(201).json(compromisso);
  } catch (err) {
    console.error('Erro ao criar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/agenda/:id — atualiza compromisso e sincroniza ─────────────────
router.put('/:id', async (req, res) => {
  const { titulo, data_hora, lembrar_antes, local, notas } = req.body;
  try {
    const antes = await db.query(
      'SELECT id, gcal_event_id FROM agenda WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuarioId]
    );
    if (antes.rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });
    const { rows } = await db.query(
      `UPDATE agenda
       SET titulo=$1, data_hora=$2, lembrar_antes=$3, local=$4, notas=$5, lembrete_enviado=FALSE
       WHERE id=$6 AND usuario_id=$7 RETURNING *`,
      [titulo, data_hora, lembrar_antes ?? 30, local || null, notas || null, req.params.id, req.usuarioId]
    );
    const compromisso  = rows[0];
    const gcalEventId  = antes.rows[0].gcal_event_id;
    if (gcalEventId) {
      atualizarEventoGcal(req.usuarioId, gcalEventId, compromisso).catch(() => {});
    } else {
      criarEventoGcal(req.usuarioId, compromisso).then(newId => {
        if (newId) db.query('UPDATE agenda SET gcal_event_id=$1 WHERE id=$2', [newId, compromisso.id]).catch(() => {});
      });
    }
    res.json(compromisso);
  } catch (err) {
    console.error('Erro ao atualizar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/agenda/:id — cancela compromisso e remove do Google Calendar ─
router.delete('/:id', async (req, res) => {
  if (req.params.id === 'gcal') return res.status(400).json({ erro: 'Rota inválida' });
  try {
    const { rows } = await db.query(
      `UPDATE agenda SET cancelado=TRUE WHERE id=$1 AND usuario_id=$2 RETURNING id, gcal_event_id`,
      [req.params.id, req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });
    if (rows[0].gcal_event_id)
      cancelarEventoGcal(req.usuarioId, rows[0].gcal_event_id).catch(() => {});
    res.json({ mensagem: 'Compromisso cancelado' });
  } catch (err) {
    console.error('Erro ao cancelar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS — GOOGLE CALENDAR (configuração por usuário)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/gcal/status', async (req, res) => {
  try {
    const calId = await getCalendarId(req.usuarioId);
    res.json({ calendar_id: calId, conectado: !!calId });
  } catch (err) {
    console.error('Erro ao buscar gcal status:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/gcal/configurar', async (req, res) => {
  const { calendar_id } = req.body;
  if (!calendar_id || !calendar_id.trim())
    return res.status(400).json({ erro: 'calendar_id é obrigatório' });
  try {
    await db.query('UPDATE usuarios SET google_calendar_id=$1 WHERE id=$2', [calendar_id.trim(), req.usuarioId]);
    res.json({ ok: true, mensagem: 'Google Calendar salvo com sucesso', calendar_id: calendar_id.trim() });
  } catch (err) {
    console.error('Erro ao salvar gcal:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/gcal/configurar', async (req, res) => {
  try {
    await db.query('UPDATE usuarios SET google_calendar_id=NULL WHERE id=$1', [req.usuarioId]);
    res.json({ ok: true, mensagem: 'Google Calendar desconectado' });
  } catch (err) {
    console.error('Erro ao desconectar gcal:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.get('/gcal/testar', async (req, res) => {
  try {
    const calId = await getCalendarId(req.usuarioId);
    if (!calId)
      return res.status(400).json({ erro: 'Google Calendar não configurado. Informe o ID do seu calendário primeiro.' });
    const auth = await getGoogleAuth();
    if (!auth)
      return res.status(503).json({ erro: 'Conta de serviço não configurada pelo admin.' });
    try {
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.list({ calendarId: calId, maxResults: 1 });
      res.json({ ok: true, mensagem: 'Conexão com o Google Calendar bem-sucedida!' });
    } catch (gErr) {
      console.error('Erro gcal teste:', gErr.message);
      res.status(400).json({ erro: 'Falha na conexão: ' + (gErr.message || 'verifique se compartilhou o calendário com a conta de serviço') });
    }
  } catch (err) {
    console.error('Erro ao testar gcal:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
// Exporta helpers para uso no bot/handler.js
module.exports.criarEventoGcal    = criarEventoGcal;
module.exports.cancelarEventoGcal = cancelarEventoGcal;
