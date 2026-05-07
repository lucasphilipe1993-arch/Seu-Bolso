// database/db.js — Pool de conexão PostgreSQL
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // Railway exige SSL
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool PostgreSQL:', err.message);
});

// Testa a conexão na inicialização
pool.query('SELECT NOW()')
  .then(() => console.log('✅ PostgreSQL conectado'))
  .catch((err) => console.error('❌ Falha ao conectar PostgreSQL:', err.message));

module.exports = pool;
