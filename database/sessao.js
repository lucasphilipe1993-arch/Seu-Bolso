const db = require('./db');

async function salvarEstado({ creds, keys }) {
  // Salva creds
  await db.query(
    `INSERT INTO whatsapp_session (chave, valor)
     VALUES ('creds', $1)
     ON CONFLICT (chave) DO UPDATE SET valor = $1`,
    [JSON.stringify(creds)]
  );

  // Salva cada key individualmente
  const entries = Object.entries(keys.toJSON?.() ?? keys);
  for (const [k, v] of entries) {
    await db.query(
      `INSERT INTO whatsapp_session (chave, valor)
       VALUES ($1, $2)
       ON CONFLICT (chave) DO UPDATE SET valor = $2`,
      [`key_${k}`, JSON.stringify(v)]
    );
  }
}

async function carregarEstado() {
  const res = await db.query(`SELECT chave, valor FROM whatsapp_session`);
  if (res.rows.length === 0) return null;

  const map = {};
  for (const row of res.rows) {
    map[row.chave] = JSON.parse(row.valor);
  }

  if (!map['creds']) return null;

  // Reconstrói as keys
  const keys = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith('key_')) {
      keys[k.replace('key_', '')] = v;
    }
  }

  return { creds: map['creds'], keys };
}

module.exports = { salvarEstado, carregarEstado };
