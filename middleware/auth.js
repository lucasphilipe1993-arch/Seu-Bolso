// middleware/auth.js — Valida JWT em rotas protegidas
const jwt = require('jsonwebtoken');
const db  = require('../database/db');

module.exports = function autenticar(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId    = payload.id;
    req.usuarioEmail = payload.email;

    // ── Atualiza presença do usuário (não bloqueia a requisição) ──────────
    // Registra ultimo_login_em e ultimo_ip a cada request autenticado.
    // Isso permite que o painel admin mostre "Online agora" se < 5 minutos.
    const ip = (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      ''
    );
    db.query(
      `UPDATE usuarios
          SET ultimo_login_em = NOW(),
              ultimo_ip       = NULLIF($2, '')
        WHERE id = $1`,
      [payload.id, ip]
    ).catch(() => {}); // fire-and-forget — nunca trava a requisição

    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
};
