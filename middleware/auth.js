// middleware/auth.js — Valida JWT em rotas protegidas
const jwt = require('jsonwebtoken');

module.exports = function autenticar(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ erro: 'Token não fornecido' });

  const token = header.split(' ')[1]; // "Bearer <token>"
  if (!token) return res.status(401).json({ erro: 'Formato inválido. Use: Bearer <token>' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = payload.id;
    req.usuarioEmail = payload.email;
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido';
    return res.status(401).json({ erro: msg });
  }
};
