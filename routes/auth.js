// routes/auth.js — Cadastro e login (CORRIGIDO)
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');

// ── Normaliza telefone → sempre sem DDI, 10 ou 11 dígitos ────
// Ex: "5531991003389" → "31991003389"
//     "(31) 99100-3389" → "31991003389"
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  let digits = telefone.replace(/\D/g, '');

  // Remove DDI 55 se o frontend já tiver enviado com ele
  if (digits.startsWith('55') && digits.length > 11) {
    digits = digits.slice(2);
  }

  // Valida: deve ter 10 (fixo) ou 11 dígitos (celular com 9)
  if (digits.length < 10 || digits.length > 11) return null;

  return digits; // ex: "31991003389"
}

// ── POST /api/auth/cadastro ──────────────────────────────
router.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone, plano } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  const telefoneLimpo = normalizarTelefone(telefone);

  try {
    // Verifica se e-mail já existe
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    // Verifica se telefone já está em uso (se informado)
    if (telefoneLimpo) {
      const telExiste = await db.query('SELECT id FROM usuarios WHERE telefone = $1', [telefoneLimpo]);
      if (telExiste.rows.length > 0)
        return res.status(409).json({ erro: 'Número de WhatsApp já cadastrado' });
    }

    const senha_hash = await bcrypt.hash(senha, 12);

    // Insere o usuário com o plano
    const { rows: usuariosInseridos } = await db.query(
      `INSERT INTO usuarios (nome, email, senha_hash, telefone, plano, whatsapp_ativo)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, email, plano`,
      [nome, email.toLowerCase(), senha_hash, telefoneLimpo, plano || 'gratuito', telefoneLimpo ? true : false]
    );

    const usuario = usuariosInseridos[0];

    // Cria conta bancária padrão
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo)
       VALUES ($1, 'Carteira', true, 0)`,
      [usuario.id]
    );

    // Cria a sessão do bot (vincula WhatsApp ao usuário)
    if (telefoneLimpo) {
      await db.query(
        `INSERT INTO sessoes_bot (telefone, usuario_id, estado)
         VALUES ($1, $2, 'ativo')
         ON CONFLICT (telefone) DO UPDATE
         SET usuario_id = $2, estado = 'ativo', atualizado_em = NOW()`,
        [telefoneLimpo, usuario.id]
      );
      console.log(`✅ Sessão criada para WhatsApp: ${telefoneLimpo} (Usuário: ${usuario.id})`);
    }

    const token = gerarToken(usuario);

    res.status(201).json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        plano: usuario.plano
      }
    });

  } catch (err) {
    console.error('❌ Erro cadastro:', err);
    res.status(500).json({ erro: 'Erro interno ao criar conta' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha)
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email.toLowerCase()]
    );

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
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        plano: usuario.plano,
        whatsapp_ativo: usuario.whatsapp_ativo
      }
    });
  } catch (err) {
    console.error('❌ Erro login:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────
const autenticar = require('../middleware/auth');
router.get('/me', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nome, email, telefone, plano, whatsapp_ativo, criado_em FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email },
    process.env.JWT_SECRET || 'seu-segredo-super-secreto-aqui',
    { expiresIn: '30d' }
  );
}

module.exports = router;
