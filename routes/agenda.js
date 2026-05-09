// routes/agenda.js — CRUD de compromissos + integração Google Calendar OAuth
const express    = require('express');
const router     = express.Router();
const db         = require('../database/db');
const autenticar = require('../middleware/auth');
const gcal       = require('../utils/gcal');

router.use(autenticar);

// ── Garante que a tabela existe (idempotente) ────────────────────────────────
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
      google_event_id  TEXT,
      criado_em        TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS google_event_id TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_usuario ON agenda(usuario_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_data    ON agenda(data_hora)`).catch(() => {});
}
garantirTabela();

// ══════════════════════════════════════════════════════════════════════════════
//  GOOGLE CALENDAR — ROTAS OAuth (devem vir ANTES de /:id)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/agenda/gcal/status ──────────────────────────────────────────────
// Retorna se o usuário já conectou o Google Calendar e qual email está vinculado
router.get('/gcal/status', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT gcal_email, gcal_access_token FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    const conectado = !!rows[0]?.gcal_access_token;
    const email     = rows[0]?.gcal_email || null;
    res.json({ conectado, email });
  } catch (err) {
    console.error('Erro ao buscar gcal status:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/agenda/gcal/autorizar ───────────────────────────────────────────
// Redireciona o usuário para a tela de autorização do Google.
// Como este endpoint faz redirect (não é JSON), o frontend envia o token
// via query param ?token=... em vez do header Authorization.
router.get('/gcal/autorizar', async (req, res) => {
  try {
    let usuarioId = req.usuarioId; // vem do middleware (se token no header)

    // Fallback: token via query param (necessário para redirects do browser)
    if (!usuarioId && req.query.token) {
      const jwt = require('jsonwebtoken');
      try {
        const decoded = jwt.verify(req.query.token, process.env.JWT_SECRET);
        usuarioId = decoded.id || decoded.usuarioId || decoded.sub;
      } catch {
        return res.status(401).json({ erro: 'Token inválido' });
      }
    }

    if (!usuarioId) return res.status(401).json({ erro: 'Não autenticado' });

    const url = gcal.gerarUrlOAuth(usuarioId);
    res.redirect(url);
  } catch (err) {
    console.error('Erro ao gerar URL OAuth:', err);
    res.status(500).json({ erro: 'Erro ao gerar link de autorização. Verifique as variáveis GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI.' });
  }
});

// ── GET /api/agenda/gcal/callback ────────────────────────────────────────────
// Google redireciona para cá após o usuário autorizar (ou negar)
// ATENÇÃO: esta rota recebe o "code" do Google. O GOOGLE_REDIRECT_URI
// no Google Cloud Console deve apontar para esta URL exata.
router.get('/gcal/callback', async (req, res) => {
  const { code, state: usuarioIdDoState, error } = req.query;

  // Usuário negou a permissão
  if (error) {
    return res.redirect('/dashboard.html?gcal=negado');
  }

  // Usa o usuarioId do middleware (sessão autenticada) ou do state
  const usuarioId = req.usuarioId || usuarioIdDoState;

  if (!code || !usuarioId) {
    return res.status(400).json({ erro: 'Parâmetros inválidos no callback' });
  }

  try {
    const { email } = await gcal.trocarCodigo(code, usuarioId);
    console.log(`✅ Google Calendar conectado para usuário ${usuarioId} (${email})`);
    res.redirect('/dashboard.html?gcal=conectado');
  } catch (err) {
    console.error('Erro ao trocar código OAuth:', err);
    res.redirect('/dashboard.html?gcal=erro');
  }
});

// ── DELETE /api/agenda/gcal/desconectar ──────────────────────────────────────
// Remove os tokens OAuth do usuário
router.delete('/gcal/desconectar', async (req, res) => {
  try {
    await gcal.desconectar(req.usuarioId);
    res.json({ ok: true, mensagem: 'Google Calendar desconectado com sucesso.' });
  } catch (err) {
    console.error('Erro ao desconectar gcal:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/agenda/gcal/testar ──────────────────────────────────────────────
// Testa se a conexão OAuth do usuário está funcionando
router.get('/gcal/testar', async (req, res) => {
  try {
    await gcal.testarConexao(req.usuarioId);
    res.json({ ok: true, mensagem: 'Conexão com o Google Calendar bem-sucedida!' });
  } catch (err) {
    console.error('Erro no teste gcal:', err.message);

    // Token revogado ou expirado sem refresh_token → pede nova autorização
    if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
      await gcal.desconectar(req.usuarioId).catch(() => {});
      return res.status(401).json({
        erro:        'Sessão com o Google expirada. Reconecte sua conta.',
        reconectar:  true,
        autorizar:   '/api/agenda/gcal/autorizar',
      });
    }

    res.status(400).json({ erro: err.message || 'Falha na conexão com o Google Calendar.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CRUD DE COMPROMISSOS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/agenda ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const agora = new Date();

  let condicao = 'cancelado = FALSE AND data_hora >= $2';
  let params   = [req.usuarioId, agora];

  if (status === 'cancelado') {
    condicao = 'cancelado = TRUE';
    params   = [req.usuarioId];
  } else if (status === 'passado') {
    condicao = 'cancelado = FALSE AND data_hora < $2';
    params   = [req.usuarioId, agora];
  }

  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, lembrar_antes, local, notas,
              lembrete_enviado, cancelado, id_curto, origem, criado_em
       FROM agenda
       WHERE usuario_id = $1 AND ${condicao}
       ORDER BY data_hora ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const total = await db.query(
      `SELECT COUNT(*) FROM agenda WHERE usuario_id = $1 AND ${condicao}`,
      params
    );

    res.json({ compromissos: rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    console.error('Erro ao listar agenda:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/agenda/proximos ─────────────────────────────────────────────────
router.get('/proximos', async (req, res) => {
  const limit = parseInt(req.query.limit) || 3;
  try {
    const { rows } = await db.query(
      `SELECT id, titulo, data_hora, local, notas, id_curto
       FROM agenda
       WHERE usuario_id = $1 AND cancelado = FALSE AND data_hora >= NOW()
       ORDER BY data_hora ASC
       LIMIT $2`,
      [req.usuarioId, limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao buscar próximos:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── POST /api/agenda ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { titulo, data_hora, lembrar_antes = 30, local, notas } = req.body;
  if (!titulo || !data_hora)
    return res.status(400).json({ erro: 'titulo e data_hora são obrigatórios' });

  try {
    const { rows } = await db.query(
      `INSERT INTO agenda (usuario_id, titulo, data_hora, lembrar_antes, local, notas, origem)
       VALUES ($1, $2, $3, $4, $5, $6, 'web')
       RETURNING *`,
      [req.usuarioId, titulo, data_hora, lembrar_antes, local || null, notas || null]
    );
    const compromisso = rows[0];

    // Sincroniza com Google Calendar (não bloqueia a resposta em caso de erro)
    const googleEventId = await gcal.criarEvento(req.usuarioId, {
      titulo,
      dataHora:     compromisso.data_hora,
      lembrarAntes: compromisso.lembrar_antes,
      local:        compromisso.local,
      notas:        compromisso.notas,
    });
    if (googleEventId) {
      await db.query(
        `UPDATE agenda SET google_event_id = $1 WHERE id = $2`,
        [googleEventId, compromisso.id]
      );
      compromisso.google_event_id = googleEventId;
    }

    res.status(201).json(compromisso);
  } catch (err) {
    console.error('Erro ao criar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/agenda/:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { titulo, data_hora, lembrar_antes, local, notas } = req.body;
  try {
    const antes = await db.query(
      'SELECT id, google_event_id FROM agenda WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuarioId]
    );
    if (antes.rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });

    const { rows } = await db.query(
      `UPDATE agenda
       SET titulo=$1, data_hora=$2, lembrar_antes=$3, local=$4, notas=$5,
           lembrete_enviado = FALSE
       WHERE id=$6 AND usuario_id=$7
       RETURNING *`,
      [titulo, data_hora, lembrar_antes ?? 30, local || null, notas || null,
       req.params.id, req.usuarioId]
    );
    const compromisso = rows[0];

    // Re-sincroniza: remove o evento antigo e cria um novo
    const antigoEventId = antes.rows[0].google_event_id;
    if (antigoEventId) {
      await gcal.cancelarEvento(req.usuarioId, antigoEventId);
    }
    const novoEventId = await gcal.criarEvento(req.usuarioId, {
      titulo:       compromisso.titulo,
      dataHora:     compromisso.data_hora,
      lembrarAntes: compromisso.lembrar_antes,
      local:        compromisso.local,
      notas:        compromisso.notas,
    });
    if (novoEventId) {
      await db.query(
        `UPDATE agenda SET google_event_id = $1 WHERE id = $2`,
        [novoEventId, compromisso.id]
      );
      compromisso.google_event_id = novoEventId;
    }

    res.json(compromisso);
  } catch (err) {
    console.error('Erro ao atualizar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── DELETE /api/agenda/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  // Guarda para não colidir com rotas /gcal/*
  if (req.params.id === 'gcal') return res.status(400).json({ erro: 'Rota inválida' });

  try {
    const { rows } = await db.query(
      `UPDATE agenda SET cancelado = TRUE
       WHERE id = $1 AND usuario_id = $2
       RETURNING id, google_event_id`,
      [req.params.id, req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Compromisso não encontrado' });

    if (rows[0].google_event_id) {
      await gcal.cancelarEvento(req.usuarioId, rows[0].google_event_id);
    }

    res.json({ mensagem: 'Compromisso cancelado' });
  } catch (err) {
    console.error('Erro ao cancelar compromisso:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
