// routes/config.js — Configurações globais do admin (Google Calendar, etc.)
const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const autenticar = require('../middleware/auth');

router.use(autenticar);

// Garante que a tabela de configurações existe
async function garantirTabela() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave      TEXT PRIMARY KEY,
      valor      TEXT NOT NULL,
      criado_em  TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}
garantirTabela();

// Helper: upsert de uma chave
async function upsert(chave, valor) {
  await db.query(`
    INSERT INTO configuracoes (chave, valor, atualizado_em)
    VALUES ($1, $2, NOW())
    ON CONFLICT (chave) DO UPDATE
      SET valor = EXCLUDED.valor, atualizado_em = NOW()
  `, [chave, valor]);
}

// Helper: busca várias chaves de uma vez → retorna objeto { chave: valor }
async function getChaves(chaves) {
  const { rows } = await db.query(
    `SELECT chave, valor FROM configuracoes WHERE chave = ANY($1)`,
    [chaves]
  );
  return Object.fromEntries(rows.map(r => [r.chave, r.valor]));
}

// ── GET /api/config ──────────────────────────────────────────────────────────
// Retorna as configurações globais (somente admin)
router.get('/', async (req, res) => {
  try {
    const cfg = await getChaves([
      'google_cal_email',
      'google_cal_calendar_id',
      'google_cal_private_key',
    ]);
    res.json(cfg);
  } catch (err) {
    console.error('Erro ao buscar configurações:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/config ──────────────────────────────────────────────────────────
// Salva as configurações globais (somente admin)
router.put('/', async (req, res) => {
  const { google_cal_email, google_cal_calendar_id, google_cal_private_key } = req.body;

  if (!google_cal_email || !google_cal_calendar_id || !google_cal_private_key) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios' });
  }

  try {
    await upsert('google_cal_email',       google_cal_email.trim());
    await upsert('google_cal_calendar_id', google_cal_calendar_id.trim());
    await upsert('google_cal_private_key', google_cal_private_key.trim());

    res.json({ ok: true, mensagem: 'Configurações salvas com sucesso' });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/gcal/test ───────────────────────────────────────────────────────
// Testa a conexão com o Google Calendar usando as credenciais globais do admin
router.get('/gcal/test', async (req, res) => {
  try {
    const cfg = await getChaves([
      'google_cal_email',
      'google_cal_calendar_id',
      'google_cal_private_key',
    ]);

    if (!cfg.google_cal_email || !cfg.google_cal_private_key || !cfg.google_cal_calendar_id) {
      return res.status(400).json({
        erro: 'Credenciais do Google Calendar não configuradas. Preencha todos os campos e salve primeiro.',
      });
    }

    try {
      const { google } = require('googleapis');
      const auth = new google.auth.JWT(
        cfg.google_cal_email,
        null,
        cfg.google_cal_private_key,
        ['https://www.googleapis.com/auth/calendar']
      );
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.list({ calendarId: cfg.google_cal_calendar_id, maxResults: 1 });
      res.json({ ok: true, mensagem: 'Conexão com o Google Calendar estabelecida com sucesso!' });
    } catch (gErr) {
      console.error('Erro ao testar Google Calendar:', gErr.message);
      res.status(400).json({
        erro: 'Falha na conexão: ' + (gErr.message || 'verifique as credenciais e o ID do calendário'),
      });
    }
  } catch (err) {
    console.error('Erro interno no teste gcal:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
