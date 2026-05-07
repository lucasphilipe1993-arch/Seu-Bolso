// routes/auth.js — Cadastro e login (CORRIGIDO)
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');

// ── POST /api/auth/cadastro ──────────────────────────────
router.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone, plano } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  // Formata telefone: remove caracteres especiais
  const telefoneLimpo = telefone 
    ? telefone.replace(/\D/g, '') 
    : null;

  try {
    // Verifica se e-mail já existe
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    const senha_hash = await bcrypt.hash(senha, 12);

    // ✅ INSERE O USUÁRIO com o PLANO
    const { rows: usuariosInseridos } = await db.query(
      `INSERT INTO usuarios (nome, email, senha_hash, telefone, plano, whatsapp_ativo)
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, nome, email, plano`,
      [nome, email.toLowerCase(), senha_hash, telefoneLimpo, plano || 'gratuito', telefoneLimpo ? true : false]
    );

    const usuario = usuariosInseridos[0];

    // ✅ CRIA CONTA BANCÁRIA PADRÃO
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo)
       VALUES ($1, 'Carteira', true, 0)`,
      [usuario.id]
    );

    // ✅ **CRIA A SESSÃO DO BOT** (conecta WhatsApp ao usuário)
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
