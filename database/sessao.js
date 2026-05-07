// Adapter que salva a sessão do Baileys no PostgreSQL
const db = require('./db');

async function salvarCreds(creds) {
  await db.query(
    `INSERT INTO whatsapp_session (chave, valor)
     VALUES ('creds', $1)
     ON CONFLICT (chave) DO UPDATE SET valor = $1`,
    [JSON.stringify(creds)]
  );
}

async function carregarCreds() {
  const res = await db.query(
    `SELECT valor FROM whatsapp_session WHERE chave = 'creds'`
  );
  if (res.rows.length === 0) return null;
  return JSON.parse(res.rows[0].valor);
}

module.exports = { salvarCreds, carregarCreds };
