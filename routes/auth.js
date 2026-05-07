// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const autenticar = require('../middleware/auth');

// ── Normaliza telefone → sempre sem DDI, 10 ou 11 dígitos ────
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  let digits = telefone.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length < 10 || digits.length > 11) return null;
  return digits;
}

// ── Referência global ao bot (injetada pelo server.js) ───────
let _botInstance = null;
function setBotInstance(bot) { _botInstance = bot; }

// ── Resolve o JID real do WhatsApp para o telefone ───────────
async function resolverJidWhatsApp(telefoneLimpo) {
  if (!_botInstance || !_botInstance.conectado) return null;

  const jidConsulta = `55${telefoneLimpo}@s.whatsapp.net`;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const [info] = await _botInstance.socket.onWhatsApp(jidConsulta);
      if (!info?.exists) return null;

      const jidReal = info.jid;

      if (jidReal.endsWith('@lid')) {
        await _botInstance._garantirTabelaLidMap();
        await db.query(
          `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2)
           ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
          [jidReal, telefoneLimpo]
        );
        _botInstance.lidCache?.set(jidReal, telefoneLimpo);
        console.log(`🔗 Cadastro: LID mapeado ${jidReal} → ${telefoneLimpo}`);
        return { jid: jidReal, lid: jidReal };
      }

      return { jid: jidReal, lid: null };
    } catch (err) {
      console.warn(`⚠️  resolverJid tentativa ${tentativa}/3 falhou:`, err.message);
      if (tentativa < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.warn(`❌ Não foi possível resolver JID para ${telefoneLimpo} após 3 tentativas`);
  return null;
}

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email },
    process.env.JWT_SECRET || 'seu-segredo-super-secreto-aqui',
    { expiresIn: '30d' }
  );
}

// ── POST /api/auth/cadastro ──────────────────────────────────
router.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone, plano } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  const telefoneLimpo = normalizarTelefone(telefone);

  try {
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    if (telefoneLimpo) {
      const telExiste = await db.query('SELECT id FROM usuarios WHERE telefone = $1', [telefoneLimpo]);
      if (telExiste.rows.length > 0)
        return res.status(409).json({ erro: 'Número de WhatsApp já cadastrado' });
    }

    const senha_hash = await bcrypt.hash(senha, 12);

    const { rows: usuariosInseridos } = await db.query(
      `INSERT INTO usuarios (nome, email, senha_hash, telefone, plano, whatsapp_ativo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, email, plano`,
      const [primeiroNome, ...restoNome] = nome.trim().split(' ');
const sobrenomeExtraido = restoNome.join(' ') || null;
    );

    const usuario = usuariosInseridos[0];

    // Cria conta bancária padrão
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo) VALUES ($1, 'Carteira', true, 0)`,
      [usuario.id]
    );

    // Vincula WhatsApp
    if (telefoneLimpo) {
      const jidInfo = await resolverJidWhatsApp(telefoneLimpo);
      const lidParaSalvar = jidInfo?.lid || null;

      await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});
      await db.query(`CREATE INDEX IF NOT EXISTS idx_sessoes_bot_lid ON sessoes_bot(lid)`).catch(() => {});

      await db.query(
        `INSERT INTO sessoes_bot (telefone, usuario_id, estado, lid)
         VALUES ($1, $2, 'ativo', $3)
         ON CONFLICT (telefone) DO UPDATE
         SET usuario_id = $2, estado = 'ativo', lid = COALESCE($3, sessoes_bot.lid), atualizado_em = NOW()`,
        [telefoneLimpo, usuario.id, lidParaSalvar]
      );

      console.log(`✅ Sessão criada para WhatsApp: ${telefoneLimpo} (Usuário: ${usuario.id})`);

      setImmediate(async () => {
        try {
          await _botInstance?.enviarBoasVindasECapturarLid(telefoneLimpo, usuario.id, usuario.nome.split(' ')[0]);
        } catch (err) {
          console.warn('Erro ao enviar boas-vindas:', err.message);
        }
      });
    }

    const token = gerarToken(usuario);
    res.status(201).json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, plano: usuario.plano }
    });

  } catch (err) {
    console.error('❌ Erro cadastro:', err);
    res.status(500).json({ erro: 'Erro interno ao criar conta' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha)
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' });

  try {
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (rows.length === 0)
      return res.status(401).json({ erro: 'Credenciais inválidas' });

    const usuario = rows[0];
    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk)
      return res.status(401).json({ erro: 'Credenciais inválidas' });

    const token = gerarToken(usuario);
    res.json({
      token,
      usuario: {
        id: usuario.id, nome: usuario.nome, sobrenome: usuario.sobrenome,
        email: usuario.email, plano: usuario.plano,
        whatsapp_ativo: usuario.whatsapp_ativo,
      }
    });
  } catch (err) {
    console.error('❌ Erro login:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', autenticar, async (req, res) => {
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

// ── PUT /api/auth/perfil ─────────────────────────────────────
// Chamado pelo dashboard em: API.salvarPerfil({ nome, sobrenome, telefone })
router.put('/perfil', autenticar, async (req, res) => {
  const { nome, sobrenome, telefone } = req.body;

  if (!nome || !nome.trim())
    return res.status(400).json({ erro: 'Nome é obrigatório' });

  const telefoneLimpo = normalizarTelefone(telefone) || telefone || null;

  try {
    // Garante coluna sobrenome existe
    await db.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sobrenome TEXT`).catch(() => {});

    // Verifica se novo telefone já pertence a outro usuário
    if (telefoneLimpo) {
      const { rows } = await db.query(
        'SELECT id FROM usuarios WHERE telefone = $1 AND id != $2',
        [telefoneLimpo, req.usuarioId]
      );
      if (rows.length > 0)
        return res.status(409).json({ erro: 'Número de WhatsApp já cadastrado por outro usuário' });
    }

    const { rows } = await db.query(
      `UPDATE usuarios
       SET nome = $1, sobrenome = $2, telefone = $3, whatsapp_ativo = $4
       WHERE id = $5
       RETURNING id, nome, sobrenome, email, telefone, plano, whatsapp_ativo`,
      [nome.trim(), sobrenome?.trim() || null, telefoneLimpo,
       telefoneLimpo ? true : false, req.usuarioId]
    );

    // Atualiza sessão do bot se telefone mudou
    if (telefoneLimpo) {
      await db.query(
        `INSERT INTO sessoes_bot (telefone, usuario_id, estado)
         VALUES ($1, $2, 'ativo')
         ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2, estado = 'ativo', atualizado_em = NOW()`,
        [telefoneLimpo, req.usuarioId]
      );
    }

    res.json({ usuario: rows[0] });
  } catch (err) {
    console.error('❌ Erro salvar perfil:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/auth/senha ──────────────────────────────────────
// Chamado pelo dashboard em: API.trocarSenha({ senhaAtual, novaSenha })
router.put('/senha', autenticar, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body;

  if (!senhaAtual || !novaSenha)
    return res.status(400).json({ erro: 'Senha atual e nova senha são obrigatórias' });

  if (novaSenha.length < 6)
    return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 6 caracteres' });

  try {
    const { rows } = await db.query(
      'SELECT senha_hash FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    const senhaOk = await bcrypt.compare(senhaAtual, rows[0].senha_hash);
    if (!senhaOk)
      return res.status(401).json({ erro: 'Senha atual incorreta' });

    const novoHash = await bcrypt.hash(novaSenha, 12);
    await db.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [novoHash, req.usuarioId]);

    res.json({ mensagem: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('❌ Erro trocar senha:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
module.exports.setBotInstance = setBotInstance;
