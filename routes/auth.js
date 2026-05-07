// routes/auth.js — Cadastro e login
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');

// ── POST /api/auth/cadastro ──────────────────────────────
router.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  try {
    // Verifica se e-mail já existe
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    const senha_hash = await bcrypt.hash(senha, 12);

    const { rows } = await db.query(
      `INSERT INTO usuarios (nome, email, senha_hash, telefone)
       VALUES ($1, $2, $3, $4) RETURNING id, nome, email`,
      [nome, email.toLowerCase(), senha_hash, telefone || null]
    );

    const usuario = rows[0];
    const token = gerarToken(usuario);

    // Cria conta bancária padrão
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao) VALUES ($1, 'Carteira', true)`,
      [usuario.id]
    );

    res.status(201).json({ token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
  } catch (err) {
    console.error('Erro cadastro:', err);
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
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, plano: usuario.plano }
    });
  } catch (err) {
    console.error('Erro login:', err);
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
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = router;
