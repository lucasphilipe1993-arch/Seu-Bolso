// bot/handler.js — Bot WhatsApp Seu Secretário
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const db = require('../database/db');
const { gerarRelatorio, limparPdfsAntigos } = require('./relatorio');
const gcal = require('../utils/gcal'); // ← sincronização Google Calendar

const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const lidCache = new Map();

const CATEGORIAS_PADRAO = [
  { nome: 'Alimentação',            emoji: '🍔', tipo: 'despesa' },
  { nome: 'Saúde',                  emoji: '🏥', tipo: 'despesa' },
  { nome: 'Assinatura',             emoji: '📱', tipo: 'despesa' },
  { nome: 'Transporte',             emoji: '🚗', tipo: 'despesa' },
  { nome: 'Viagem',                 emoji: '✈️',  tipo: 'despesa' },
  { nome: 'Doações',                emoji: '🤝', tipo: 'despesa' },
  { nome: 'Impostos',               emoji: '🧾', tipo: 'despesa' },
  { nome: 'Mercado',                emoji: '🛒', tipo: 'despesa' },
  { nome: 'Educação',               emoji: '📚', tipo: 'despesa' },
  { nome: 'Cuidados pessoais',      emoji: '💅', tipo: 'despesa' },
  { nome: 'Lazer e Entretenimento', emoji: '🎉', tipo: 'despesa' },
  { nome: 'Vestuário',              emoji: '👗', tipo: 'despesa' },
  { nome: 'Pets',                   emoji: '🐾', tipo: 'despesa' },
  { nome: 'Casa',                   emoji: '🏠', tipo: 'despesa' },
  { nome: 'Salário',                emoji: '💰', tipo: 'receita' },
  { nome: 'Outros',                 emoji: '📦', tipo: 'ambos'   },
];

const EMOJI_CATEGORIA = {
  'Alimentação': '🍔', 'Saúde': '🏥', 'Assinatura': '📱',
  'Transporte': '🚗', 'Viagem': '✈️', 'Doações': '🤝',
  'Impostos': '🧾', 'Mercado': '🛒', 'Educação': '📚',
  'Cuidados pessoais': '💅', 'Lazer e Entretenimento': '🎉',
  'Vestuário': '👗', 'Pets': '🐾', 'Casa': '🏠',
  'Salário': '💰', 'Freelance': '💼', 'Outros': '📦',
};

// ── SYSTEM PROMPT — suporta múltiplas transações ────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente financeiro do Seu Secretário.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.

A mensagem pode conter UMA ou MAIS transações financeiras.

Se houver transações, retorne um ARRAY JSON:
[
  {"tipo":"despesa"|"receita","valor":numero,"descricao":"texto curto","categoria":"..."},
  ...
]

Se NÃO houver nenhuma transação financeira:
null

Categorias e quando usar:
- Alimentação: restaurante, lanche, ifood, delivery, comida, almoço, jantar
- Saúde: farmácia, médico, consulta, remédio, academia, plano de saúde, dentista
- Assinatura: netflix, spotify, amazon prime, disney+, youtube premium, clube, mensalidade de app
- Transporte: uber, gasolina, ônibus, metrô, 99, passagem, táxi, estacionamento, pedágio
- Viagem: hotel, passagem aérea, hospedagem, turismo, passeio
- Mercado: mercado, supermercado, feira, hortifruti, compras de casa
- Educação: curso, livro, escola, faculdade, treinamento
- Cuidados pessoais: salão, barbearia, estética, perfume, cosméticos, higiene
- Lazer e Entretenimento: cinema, show, bar, balada, jogo, viagem de lazer
- Vestuário: roupa, sapato, tênis, calçado, acessório, bolsa
- Pets: ração, veterinário, banho e tosa, pet shop
- Casa: aluguel, condomínio, água, luz, energia, internet, gás, móvel, reforma
- Doações: doação, caridade, esmola, contribuição
- Impostos: IPTU, IPVA, imposto, taxa, multa
- Salário: salário, holerite, pagamento recebido, pró-labore
- Outros: qualquer coisa não listada acima

Exemplos de múltiplas transações:
Entrada: "gastei 50 com comida 30 com uber e 10 com almoço"
Saída: [{"tipo":"despesa","valor":50,"descricao":"comida","categoria":"Alimentação"},{"tipo":"despesa","valor":30,"descricao":"uber","categoria":"Transporte"},{"tipo":"despesa","valor":10,"descricao":"almoço","categoria":"Alimentação"}]

Entrada: "paguei 120 de luz e recebi 3000 de salário"
Saída: [{"tipo":"despesa","valor":120,"descricao":"conta de luz","categoria":"Casa"},{"tipo":"receita","valor":3000,"descricao":"salário","categoria":"Salário"}]`;

const SYSTEM_PROMPT_DIVIDA = `Você é o assistente financeiro do Seu Secretário.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.
Hoje é: {DATA_HOJE}.

Se a mensagem indica que OUTRA PESSOA deve dinheiro ao usuário (empréstimo, dívida futura a receber):
{"tipo":"divida_receber","devedor":"nome","valor":numero,"descricao":"texto curto","data_vencimento":"YYYY-MM-DD ou null"}

Se NÃO for sobre receber dinheiro de terceiros:
null

Exemplos que SÃO dívidas a receber (outra pessoa deve ao usuário):
- "Bruno me deve 40 reais" → devedor: Bruno
- "Emprestei 200 pra Ana, ela paga dia 15/10" → devedor: Ana, data_vencimento: {ANO_ATUAL}-10-15
- "Carlos vai me devolver 50 semana que vem" → devedor: Carlos
- "Marcos me deve 300, vai pagar no fim do mês" → devedor: Marcos

Exemplos que NÃO são dívidas a receber:
- "Paguei 50 no mercado" → null
- "Devo 100 pra academia" → null
- "Recebi salário" → null
- "Conta de luz 120" → null

Para data_vencimento: converta "dia 30", "dia 15/10", "fim do mês", "semana que vem" para YYYY-MM-DD usando OBRIGATORIAMENTE o ano de {ANO_ATUAL}. Se não houver data clara, use null.`;

// ── SYSTEM PROMPT — Agenda ──────────────────────────────────────────────────
const SYSTEM_PROMPT_AGENDA = `Você é o assistente de agenda do Seu Secretário.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.
Hoje é: {DATA_HOJE}. Hora atual (BRT): {HORA_ATUAL}.

Se a mensagem descreve um compromisso, evento, reunião, consulta, tarefa agendada ou lembrete futuro:
{"tipo":"compromisso","titulo":"texto curto do compromisso","data_hora":"YYYY-MM-DD HH:MM","lembrar_antes":30,"local":"local ou null","notas":"observações ou null"}

Regras para data_hora:
- "amanhã às 10h" → próximo dia às 10:00
- "hoje às 15h" → hoje às 15:00
- "sexta às 14h" → próxima sexta às 14:00
- "dia 20 às 9h" → dia 20 do mês atual (ou próximo se já passou) às 09:00
- "segunda de manhã" → próxima segunda às 09:00
- "à tarde" → 14:00, "de manhã" → 09:00, "à noite" → 20:00
- Se não houver hora → usar 09:00

lembrar_antes: minutos antes para lembrar (padrão 30). Se disser "me lembra 1 hora antes" → 60.

Se NÃO for compromisso/agenda:
null

Exemplos:
"tenho consulta médica amanhã às 10h" → {"tipo":"compromisso","titulo":"Consulta médica","data_hora":"2025-06-15 10:00","lembrar_antes":30,"local":null,"notas":null}
"reunião com o cliente sexta às 14h no escritório" → {"tipo":"compromisso","titulo":"Reunião com cliente","data_hora":"2025-06-20 14:00","lembrar_antes":30,"local":"escritório","notas":null}
"lembra de pagar o aluguel dia 5" → {"tipo":"compromisso","titulo":"Pagar aluguel","data_hora":"2025-07-05 09:00","lembrar_antes":30,"local":null,"notas":null}`;

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function gerarIdCurto() {
  let id = '';
  for (let i = 0; i < 3; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return id;
}

// ────────────────────────────────────────────────────────────────────────────
// Auth PostgreSQL
// ────────────────────────────────────────────────────────────────────────────
async function usePostgresAuthState() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_session (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  async function readData(key) {
    try {
      const res = await db.query('SELECT valor FROM whatsapp_session WHERE chave = $1', [key]);
      if (res.rows.length === 0) return null;
      return JSON.parse(res.rows[0].valor, BufferJSON.reviver);
    } catch { return null; }
  }

  async function writeData(key, data) {
    const valor = JSON.stringify(data, BufferJSON.replacer);
    await db.query(
      `INSERT INTO whatsapp_session (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
       ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = NOW()`,
      [key, valor]
    );
  }

  async function removeData(key) {
    await db.query('DELETE FROM whatsapp_session WHERE chave = $1', [key]);
  }

  const state = {
    creds: (await readData('creds')) || initAuthCreds(),
    keys: makeCacheableSignalKeyStore(
      {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`key-${type}-${id}`);
            if (val) data[id] = val;
          }
          return data;
        },
        set: async (data) => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, val] of Object.entries(ids)) {
              if (val) await writeData(`key-${type}-${id}`, val);
              else await removeData(`key-${type}-${id}`);
            }
          }
        },
      },
      {
        level: 'silent',
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {}, fatal: () => {},
        child: () => ({
          level: 'silent',
          trace: () => {}, debug: () => {}, info: () => {},
          warn: () => {}, error: () => {}, fatal: () => {},
          child: () => ({}),
        }),
      }
    ),
  };

  return {
    state,
    saveCreds: async () => { await writeData('creds', state.creds); },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Classe principal
// ────────────────────────────────────────────────────────────────────────────
class BotSeuSecretario {
  constructor() {
    this.socket = null;
    this.conectado = false;
    this.qrAtual = null;
    this.lidCache = lidCache;
    this._tentativas = 0;
    this._reconectando = false;
    this._timerReconexao = null;
    this.onQR = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onNovaTransacao = null;
    this._estadosCategoriaFluxo = new Map();
    this._timerLembretes = null;
  }

  get _logger() {
    const silent = () => {};
    const base = { level: 'silent', trace: silent, debug: silent, info: silent, warn: console.warn, error: console.error, fatal: console.error };
    base.child = () => ({ ...base, child: base.child });
    return base;
  }

  _normalizarTelefone(telefone) {
    if (!telefone) return null;
    let digits = telefone.replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
    if (digits.length === 10) {
      const ddd = digits.slice(0, 2);
      const numero = digits.slice(2);
      if (['6','7','8','9'].includes(numero[0])) {
        digits = ddd + '9' + numero;
        console.log(`📞 Número normalizado (sem 9 → com 9): ${telefone} → ${digits}`);
      }
    }
    return digits;
  }

  _gerarVariacoesTelefone(telefone) {
    if (!telefone || telefone.endsWith('@lid')) return [];
    const variacoes = new Set();
    variacoes.add(telefone);
    let digits = telefone.replace(/\D/g, '');
    const semDDI = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
    const comDDI = '55' + semDDI;
    variacoes.add(semDDI);
    variacoes.add(comDDI);
    if (semDDI.length === 10) {
      const ddd = semDDI.slice(0, 2);
      const numero = semDDI.slice(2);
      const com9 = ddd + '9' + numero;
      variacoes.add(com9);
      variacoes.add('55' + com9);
    }
    if (semDDI.length === 11) {
      const ddd = semDDI.slice(0, 2);
      const numero = semDDI.slice(2);
      if (numero.startsWith('9')) {
        const sem9 = ddd + numero.slice(1);
        variacoes.add(sem9);
        variacoes.add('55' + sem9);
      }
    }
    return Array.from(variacoes);
  }

  async _fecharSocket() {
    if (!this.socket) return;
    const socketAntigo = this.socket;
    this.socket = null;
    try {
      socketAntigo.ev.removeAllListeners();
      const ws = socketAntigo.ws;
      if (ws && ws.readyState === 1) {
        ws.close(1000);
        await new Promise(resolve => {
          const fallback = setTimeout(resolve, 5000);
          ws.once('close', () => { clearTimeout(fallback); resolve(); });
        });
      }
    } catch {}
  }

  _agendarReconexao() {
    if (this._timerReconexao) { clearTimeout(this._timerReconexao); this._timerReconexao = null; }
    this._tentativas += 1;
    if (this._tentativas > 10) { console.error('❌ Máximo de tentativas atingido.'); return; }
    const delay = Math.min(5000 * Math.pow(2, this._tentativas - 1), 60000);
    console.log(`🔁 Tentativa ${this._tentativas}/10 em ${delay / 1000}s...`);
    this._timerReconexao = setTimeout(async () => { this._timerReconexao = null; await this.iniciar(); }, delay);
  }

  async _garantirTabelaLidMap() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS lid_map (
        lid TEXT PRIMARY KEY,
        telefone TEXT NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async _garantirTabelaDividas() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS dividas_receber (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id       UUID NOT NULL,
        devedor          TEXT NOT NULL,
        descricao        TEXT,
        valor            NUMERIC(12,2) NOT NULL,
        data_vencimento  DATE,
        data_recebimento DATE,
        status           TEXT NOT NULL DEFAULT 'pendente',
        origem           TEXT DEFAULT 'whatsapp',
        mensagem_raw     TEXT,
        id_curto         TEXT,
        criado_em        TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_dividas_usuario ON dividas_receber(usuario_id)`).catch(() => {});
  }

  // ── Tabela de agenda ────────────────────────────────────────────────────
  async _garantirTabelaAgenda() {
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
        origem           TEXT DEFAULT 'whatsapp',
        google_event_id  TEXT,
        criado_em        TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS google_event_id TEXT`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_usuario ON agenda(usuario_id)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_agenda_data ON agenda(data_hora)`).catch(() => {});
  }

  async _garantirCategoriasPadrao(usuarioId) {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_categorias_usuario_nome
      ON categorias (usuario_id, LOWER(nome))
      WHERE usuario_id IS NOT NULL
    `).catch(() => {});
    for (const cat of CATEGORIAS_PADRAO) {
      await db.query(
        `INSERT INTO categorias (usuario_id, nome, tipo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [usuarioId, cat.nome, cat.tipo]
      ).catch(() => {
        return db.query(
          `INSERT INTO categorias (usuario_id, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [usuarioId, cat.nome]
        ).catch(() => {});
      });
    }
  }

  async _resolverTelefone(remoteJid) {
    if (remoteJid.endsWith('@s.whatsapp.net'))
      return this._normalizarTelefone(remoteJid.replace('@s.whatsapp.net', ''));
    if (lidCache.has(remoteJid)) return lidCache.get(remoteJid);
    try {
      await this._garantirTabelaLidMap();
      const res = await db.query('SELECT telefone FROM lid_map WHERE lid = $1', [remoteJid]);
      if (res.rows.length > 0) {
        const telefone = this._normalizarTelefone(res.rows[0].telefone);
        lidCache.set(remoteJid, telefone);
        return telefone;
      }
    } catch {}
    if (this.socket) {
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
          const [info] = await this.socket.onWhatsApp(remoteJid);
          if (info?.jid?.endsWith('@s.whatsapp.net')) {
            const telefone = this._normalizarTelefone(info.jid.replace('@s.whatsapp.net', ''));
            lidCache.set(remoteJid, telefone);
            await this._garantirTabelaLidMap();
            await db.query(
              `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
              [remoteJid, telefone]
            );
            return telefone;
          }
        } catch (err) {
          console.warn(`onWhatsApp tentativa ${tentativa}/3 falhou para ${remoteJid}:`, err.message);
        }
        if (tentativa < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.warn(`⚠️  Não foi possível resolver LID ${remoteJid}`);
    return remoteJid;
  }

  // ────────────────────────────────────────────────────────────────────────
  // iniciar
  // ────────────────────────────────────────────────────────────────────────
  async iniciar() {
    if (this._reconectando) { console.log('⏳ Reconexão já em andamento.'); return; }
    this._reconectando = true;
    await this._fecharSocket();

    try {
      const { state, saveCreds } = await usePostgresAuthState();
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`🔧 Baileys versão WA: ${version.join('.')}, latest: ${isLatest}`);

      this.socket = makeWASocket({
        version, auth: state,
        browser: ['SeuSecretario', 'Chrome', '120.0.0'],
        logger: this._logger, syncFullHistory: false,
        connectTimeoutMs: 90000, defaultQueryTimeoutMs: 90000,
        keepAliveIntervalMs: 20000, retryRequestDelayMs: 3000,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
        fireInitQueries: false,
      });

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
          if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
            const telefone = this._normalizarTelefone(contact.id.replace('@s.whatsapp.net', ''));
            try {
              await this._garantirTabelaLidMap();
              await db.query(
                `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
                [contact.lid, telefone]
              );
              lidCache.set(contact.lid, telefone);
            } catch (err) { console.warn(`Erro ao salvar LID:`, err.message); }
          }
        }
      });

      this.socket.ev.on('contacts.update', async (contacts) => {
        for (const contact of contacts) {
          if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
            const telefone = this._normalizarTelefone(contact.id.replace('@s.whatsapp.net', ''));
            try {
              await this._garantirTabelaLidMap();
              await db.query(
                `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
                [contact.lid, telefone]
              );
              lidCache.set(contact.lid, telefone);
            } catch (err) { console.warn(`Erro ao salvar LID:`, err.message); }
          }
        }
      });

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          this.qrAtual = qr;
          console.log('📱 QR Code gerado');
          if (this.onQR) this.onQR(qr);
        }
        if (connection === 'open') {
          this.conectado = true; this.qrAtual = null;
          this._tentativas = 0; this._reconectando = false;
          console.log('✅ WhatsApp Bot conectado!');
          this._iniciarChecagemLembretes();
          if (this.onConnected) this.onConnected();
        }
        if (connection === 'close') {
          this.conectado = false; this._reconectando = false;
          this._pararChecagemLembretes();
          const codigo = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = codigo === DisconnectReason.loggedOut;
          const isConflict = lastDisconnect?.error?.output?.payload?.error?.type === 'conflict'
            || lastDisconnect?.error?.message?.includes('conflict');
          console.log(`⚠️  Desconectado (código: ${codigo}${isConflict ? ', conflict' : ''}). Reconectar: ${!loggedOut}`);
          if (this.onDisconnected) this.onDisconnected();
          if (loggedOut) {
            console.warn('🚪 Sessão encerrada. Limpando credenciais...');
            try { await db.query(`DELETE FROM whatsapp_session`); } catch {}
            this._tentativas = 0;
            this._agendarReconexao();
            return;
          }
          if (isConflict) {
            console.log('⏳ Conflict detectado. Aguardando 8s...');
            await new Promise(r => setTimeout(r, 8000));
            this._tentativas = 0;
          }
          this._agendarReconexao();
        }
      });

      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (!msg.message) continue;
          const remoteJid = msg.key.remoteJid || '';
          if (remoteJid.endsWith('@g.us')) continue;
          if (remoteJid === 'status@broadcast') continue;
          if (!remoteJid.endsWith('@s.whatsapp.net') && !remoteJid.endsWith('@lid')) continue;

          const telefone = await this._resolverTelefone(remoteJid);
          console.log(`📩 mensagem de: ${telefone} | pushName: ${msg.pushName}`);

          const tipoMsg = this._tipoMensagem(msg);
          try {
            await this._roteador(telefone, remoteJid, tipoMsg, msg, msg.pushName);
          } catch (err) {
            console.error(`Erro ao processar msg de ${telefone}:`, err.message);
            await this.enviar(remoteJid, '⚠️ Ocorreu um erro. Tente novamente em instantes.');
          }
        }
      });

    } catch (err) {
      console.error('❌ Erro ao iniciar bot:', err.message);
      this._reconectando = false;
      this._agendarReconexao();
    }
  }

  // ── Loop de lembretes ───────────────────────────────────────────────────
  _iniciarChecagemLembretes() {
    if (this._timerLembretes) return;
    console.log('⏰ Loop de lembretes iniciado (intervalo: 1min)');
    this._timerLembretes = setInterval(() => this._verificarLembretes(), 60 * 1000);
    this._verificarLembretes();
  }

  _pararChecagemLembretes() {
    if (this._timerLembretes) {
      clearInterval(this._timerLembretes);
      this._timerLembretes = null;
      console.log('⏰ Loop de lembretes parado.');
    }
  }

  async _verificarLembretes() {
    if (!this.conectado || !this.socket) return;
    try {
      await this._garantirTabelaAgenda();

      const { rows } = await db.query(`
        SELECT a.*, s.telefone
        FROM agenda a
        JOIN sessoes_bot s ON s.usuario_id = a.usuario_id
        WHERE a.cancelado = false
          AND a.lembrete_enviado = false
          AND (a.data_hora - (a.lembrar_antes || ' minutes')::INTERVAL) <= NOW()
          AND a.data_hora >= NOW() - INTERVAL '2 hours'
      `);

      for (const comp of rows) {
        try {
          const jid = `55${comp.telefone}@s.whatsapp.net`;
          const dataHora = new Date(comp.data_hora);
          const dataFmt = dataHora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
          const horaFmt = dataHora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

          const agora = new Date();
          const diffMin = Math.round((dataHora - agora) / 60000);
          const tempoLabel = diffMin <= 0
            ? '⚠️ *AGORA!*'
            : diffMin < 60
              ? `em *${diffMin} minutos*`
              : `em *${Math.round(diffMin / 60)}h${diffMin % 60 > 0 ? diffMin % 60 + 'min' : ''}*`;

          let msg = `🔔 *Lembrete de Compromisso!*\n\n`;
          msg += `📌 *${comp.titulo}*\n`;
          msg += `📅 ${dataFmt} às ${horaFmt} — ${tempoLabel}\n`;
          if (comp.local) msg += `📍 Local: ${comp.local}\n`;
          if (comp.notas) msg += `📝 Nota: ${comp.notas}\n`;
          msg += `\n🔖 ID: *${comp.id_curto}*\n`;
          msg += `\n_Para cancelar: "cancelar compromisso ${comp.id_curto}"_`;

          await this.enviar(jid, msg);

          await db.query(
            `UPDATE agenda SET lembrete_enviado = true WHERE id = $1`,
            [comp.id]
          );
          console.log(`🔔 Lembrete enviado: ${comp.titulo} → ${comp.telefone}`);
        } catch (err) {
          console.error(`Erro ao enviar lembrete ${comp.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Erro ao verificar lembretes:', err.message);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  _tipoMensagem(msg) {
    const m = msg.message;
    if (m.conversation || m.extendedTextMessage) return 'texto';
    if (m.audioMessage) return 'audio';
    if (m.imageMessage) return 'imagem';
    if (m.documentMessage) return 'documento';
    return 'outro';
  }

  async _roteador(telefone, remoteJid, tipo, msg, pushName = null) {
    console.log(`🔍 _roteador: telefone=${telefone}, tipo=${tipo}`);

    if (this._estadosCategoriaFluxo.has(telefone) && tipo === 'texto') {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      return this._continuarFluxoCategoria(telefone, remoteJid, texto);
    }

    const sessao = await this._buscarSessao(telefone, remoteJid, pushName);
    if (!sessao) {
      return this.enviar(remoteJid,
        `Olá! 👋\n\nEste número não está vinculado a nenhuma conta Seu Secretário.\n\nAcesse o painel em *https://www.seusecretario.com.br* e cadastre-se para começar!`
      );
    }

    if (remoteJid.endsWith('@lid') && sessao.telefone) {
      try {
        await this._garantirTabelaLidMap();
        await db.query(
          `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
          [remoteJid, sessao.telefone]
        );
        lidCache.set(remoteJid, sessao.telefone);
      } catch {}
    }

    const { usuarioId, nome } = sessao;

    if (tipo === 'texto') {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      await this.processarTexto(remoteJid, usuarioId, nome, texto, telefone);
    } else if (tipo === 'audio') {
      await this.enviar(remoteJid, '🎵 Recebi seu áudio! Transcrevendo...');
      const transcricao = await this._transcreverAudio(msg);
      if (!transcricao) return this.enviar(remoteJid, '❌ Não consegui entender o áudio. Tente enviar texto.');
      console.log(`🎙️ Transcrição: ${transcricao}`);
      await this.enviar(remoteJid, `🎙️ _Entendi: "${transcricao}"_`);
      await this.processarTexto(remoteJid, usuarioId, nome, transcricao, telefone);
    } else if (tipo === 'imagem') {
      await this.enviar(remoteJid, '🖼️ Recebi sua imagem! Analisando...');
      const resultado = await this._analisarImagem(msg);
      if (!resultado) return this.enviar(remoteJid, '❌ Não consegui extrair informações desta imagem. Tente enviar o valor em texto.');
      await this.registrarTransacao(remoteJid, usuarioId, resultado, '[imagem]', telefone);
    } else {
      console.log(`⏭️  Tipo de mensagem ignorado: ${tipo} de ${telefone}`);
    }
  }

  async _buscarSessao(telefone, remoteJid = null, pushName = null) {
    await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});

    const variacoes = this._gerarVariacoesTelefone(telefone);
    let res = { rows: [] };

    for (const tel of variacoes) {
      res = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
        [tel]
      );
      if (res.rows.length > 0) {
        if (tel !== telefone) {
          await db.query(`UPDATE sessoes_bot SET telefone = $1 WHERE telefone = $2`, [telefone, tel]).catch(() => {});
          await db.query(`UPDATE usuarios SET telefone = $1 WHERE telefone = $2`, [telefone, tel]).catch(() => {});
        }
        break;
      }
    }

    if (res.rows.length === 0 && remoteJid?.endsWith('@lid')) {
      res = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.lid = $1`,
        [remoteJid]
      );
    }

    if (res.rows.length === 0 && remoteJid?.endsWith('@lid')) {
      try {
        const mapRes = await db.query('SELECT telefone FROM lid_map WHERE lid = $1', [remoteJid]);
        if (mapRes.rows.length > 0) {
          const telDoMap = mapRes.rows[0].telefone;
          const variacoesMap = this._gerarVariacoesTelefone(telDoMap);
          for (const tel of variacoesMap) {
            res = await db.query(
              `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
               JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
              [tel]
            );
            if (res.rows.length > 0) break;
          }
        }
      } catch {}
    }

    if (res.rows.length === 0 && pushName && remoteJid?.endsWith('@lid')) {
      try {
        const primeiroNome = pushName.split(' ')[0];
        res = await db.query(
          `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
           JOIN usuarios u ON u.id = s.usuario_id
           WHERE LOWER(u.nome) LIKE LOWER($1) LIMIT 1`,
          [`${primeiroNome}%`]
        );
        if (res.rows.length > 0) {
          const telEncontrado = res.rows[0].telefone;
          try {
            await this._garantirTabelaLidMap();
            await db.query(
              `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
              [remoteJid, telEncontrado]
            );
            lidCache.set(remoteJid, telEncontrado);
            await db.query(`UPDATE sessoes_bot SET lid = $1 WHERE telefone = $2`, [remoteJid, telEncontrado]).catch(() => {});
          } catch {}
        }
      } catch (err) { console.warn('Erro no fallback por pushName:', err.message); }
    }

    if (res.rows.length === 0) return null;
    return {
      usuarioId: res.rows[0].usuario_id,
      nome: res.rows[0].nome.split(' ')[0],
      telefone: res.rows[0].telefone,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // processarTexto
  // ────────────────────────────────────────────────────────────────────────
  async processarTexto(remoteJid, usuarioId, nome, texto, telefone) {
    const textoLower = texto.toLowerCase().trim();
    const textoClean = textoLower.replace(/[.,!?;:]+$/, '').trim();

    if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start', 'hello', 'bom dia', 'boa tarde', 'boa noite'].includes(textoClean))
      return this.enviar(remoteJid, this.msgBemVindo(nome));

    const padroesPrimeiroContato = [
      /acabei de criar/i, /acabei de me cadastrar/i, /acabei de cadastrar/i,
      /acabo de criar/i, /acabo de me cadastrar/i, /me cadastrei/i,
      /fiz meu cadastro/i, /criei minha conta/i,
      /meu nome [eé]/i, /me chamo/i, /sou o\b/i, /sou a\b/i,
    ];
    if (padroesPrimeiroContato.some(p => p.test(textoClean)))
      return this.enviar(remoteJid, this.msgBemVindo(nome));

    const triggerResumo = [
      'resumo', 'saldo', 'extrato', 'ver resumo', 'resumo financeiro',
      'relatorio', 'relatório', 'gerar relatorio', 'gerar relatório',
      'relatorio de gastos', 'relatório de gastos', 'ver relatorio',
      'ver relatório', 'meus gastos', 'gastos do mes', 'gastos do mês',
      'quanto gastei', 'quanto recebi', 'balanço', 'balanco',
    ];
    if (triggerResumo.includes(textoClean) || (textoClean.includes('relat') && !textoClean.includes('pdf')))
      return this.enviarResumo(remoteJid, usuarioId, nome);

    if (['ajuda', 'help', '?', 'menu'].includes(textoClean))
      return this.enviar(remoteJid, this.msgAjuda());

    if (['categorias', 'ver categorias', 'minhas categorias', 'listar categorias'].includes(textoClean))
      return this.enviarCategorias(remoteJid, usuarioId);

    if (textoClean.startsWith('nova categoria') || textoClean.startsWith('adicionar categoria') || textoClean === 'add categoria')
      return this.iniciarFluxoNovaCategoria(remoteJid, telefone);

    const regexUltima = /^(exclu[iíií]r?|desfazer|apagar|cancelar|deletar)(\s+a?)?\s+(u[lL]tima|u[lL]timo|[uú]lt[iíií]m[ao]|ult\.?)(\s+(transa[çc][ãa]o|lancamento|lançamento|gasto|registro))?[.,!?]?$/i;
    if (regexUltima.test(textoClean) || textoClean === 'desfazer' || textoClean === 'undo')
      return this.excluirUltimaTransacao(remoteJid, usuarioId);

    const matchExcluir = texto.match(
      /^(?:excluir\s+(?:transa[çc][aã]o\s+)?|cancelar\s+|desfazer\s+|deletar\s+|apagar\s+)([A-Z0-9]{2,6})[.,!?;:\s]*$/i
    );
    if (matchExcluir)
      return this.excluirTransacao(remoteJid, usuarioId, matchExcluir[1].toUpperCase());

    if (['últimas', 'ultimas', 'últimos', 'historico', 'histórico', 'últimas transações', 'historico de transacoes', 'histórico de transações'].includes(textoClean))
      return this.enviarUltimasTransacoes(remoteJid, usuarioId);

    const triggerPdf = [
      'pdf', 'relatorio pdf', 'relatório pdf', 'gerar pdf',
      'exportar pdf', 'baixar relatorio', 'baixar relatório',
      'relatorio mensal', 'relatório mensal',
      'pdf do mes', 'pdf do mês', 'extrato pdf',
      'exportar relatorio', 'exportar relatório',
    ];
    if (triggerPdf.includes(textoClean) || textoClean.includes('pdf'))
      return this.gerarEEnviarRelatorioPDF(remoteJid, usuarioId, nome);

    const triggerAgenda = [
      'agenda', 'compromissos', 'meus compromissos', 'ver agenda',
      'ver compromissos', 'próximos compromissos', 'proximos compromissos',
      'lista de compromissos', 'lista compromissos', 'listar compromissos',
    ];
    if (triggerAgenda.includes(textoClean))
      return this.enviarAgenda(remoteJid, usuarioId);

    const matchCancelarComp = texto.match(
      /^(?:cancelar\s+compromisso|deletar\s+compromisso|excluir\s+compromisso|remover\s+compromisso)\s+([A-Z0-9]{2,6})[.,!?\s]*$/i
    );
    if (matchCancelarComp)
      return this.cancelarCompromisso(remoteJid, usuarioId, matchCancelarComp[1].toUpperCase());

    const triggerDividas = [
      'a receber', 'dividas', 'dívidas', 'quem me deve',
      'devedores', 'cobranças', 'cobrancas', 'ver dividas',
      'ver dívidas', 'lista de devedores',
    ];
    if (triggerDividas.includes(textoClean))
      return this.enviarDividasReceber(remoteJid, usuarioId);

    const matchQuitar = texto.match(
      /^(?:recebido|recebi|pago|paguei|quitar|quitado|liquidar|liquidado)\s+([A-Z0-9]{2,6})[.,!?\s]*$/i
    );
    if (matchQuitar)
      return this.quitarDivida(remoteJid, usuarioId, matchQuitar[1].toUpperCase());

    const divida = await this.interpretarDivida(texto);
    if (divida)
      return this.registrarDividaReceber(remoteJid, usuarioId, divida, texto);

    // ── Comando explícito "agendar" ─────────────────────────────────────────
    // Exemplos suportados:
    //   "agendar Lucas para amanhã 12hs"
    //   "agendar reunião amanhã às 10h"
    //   "agendar consulta médica dia 20 às 14h no hospital"
    //   "agendar lista de compromissos" → mostra agenda
    const matchAgendar = texto.match(/^agendar\s+(.+)$/i);
    if (matchAgendar) {
      const conteudo = matchAgendar[1].trim();
      const isListar = /^(lista\s+(de\s+)?compromissos?|compromissos?|agenda|tudo|todos?)$/i.test(conteudo);
      if (isListar) {
        return this.enviarAgenda(remoteJid, usuarioId);
      }
      // Monta frase normalizada para o interpretador de compromisso da IA
      const textoNormalizado = `tenho compromisso com ${conteudo}`;
      console.log(`📅 Comando "agendar" detectado → interpretando: "${textoNormalizado}"`);
      const compromissoAgendar = await this.interpretarCompromisso(textoNormalizado);
      if (compromissoAgendar) {
        return this.registrarCompromisso(remoteJid, usuarioId, compromissoAgendar, texto);
      }
      // Fallback: tenta com o texto original sem prefixo
      const compromissoFallback = await this.interpretarCompromisso(conteudo);
      if (compromissoFallback) {
        return this.registrarCompromisso(remoteJid, usuarioId, compromissoFallback, texto);
      }
      return this.enviar(remoteJid,
        `📅 Não consegui entender o compromisso. Tente assim:\n\n` +
        `• _agendar reunião amanhã às 10h_\n` +
        `• _agendar consulta médica dia 20 às 14h_\n` +
        `• _agendar Lucas para amanhã 12hs_\n` +
        `• _agendar lista de compromissos_ → ver agenda`
      );
    }
    // ────────────────────────────────────────────────────────────────────────

    const compromisso = await this.interpretarCompromisso(texto);
    if (compromisso)
      return this.registrarCompromisso(remoteJid, usuarioId, compromisso, texto);

    console.log(`🧠 Interpretando transação: "${texto}"`);
    const transacoes = await this.interpretarTransacao(texto);
    console.log(`🧠 Resultado:`, JSON.stringify(transacoes));

    if (transacoes && transacoes.length > 0) {
      if (transacoes.length === 1) {
        await this.registrarTransacao(remoteJid, usuarioId, transacoes[0], texto, telefone);
      } else {
        await this.enviar(remoteJid, `📋 Encontrei *${transacoes.length} transações*. Registrando...`);
        const registradas = [];
        for (const tx of transacoes) {
          try {
            const idCurto = await this.registrarTransacaoSilencioso(remoteJid, usuarioId, tx, texto);
            registradas.push({ ...tx, idCurto });
          } catch (err) {
            console.error('Erro ao registrar transação múltipla:', err.message);
          }
        }
        const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        let msg = `✅ *${registradas.length} transações registradas!*\n\n`;
        let totalDespesas = 0, totalReceitas = 0;
        for (const tx of registradas) {
          const emoji = tx.tipo === 'despesa' ? '💸' : '💰';
          const emojiCat = EMOJI_CATEGORIA[tx.categoria] || '📦';
          msg += `${emoji} *${tx.descricao}* — ${fmt(tx.valor)}\n`;
          msg += `   ${emojiCat} ${tx.categoria} | 🔖 *${tx.idCurto}*\n\n`;
          if (tx.tipo === 'despesa') totalDespesas += tx.valor;
          else totalReceitas += tx.valor;
        }
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        if (totalDespesas > 0) msg += `💸 Total despesas: *${fmt(totalDespesas)}*\n`;
        if (totalReceitas > 0) msg += `💰 Total receitas: *${fmt(totalReceitas)}*\n`;
        msg += `\n🗑️ Para excluir: _"excluir [ID]"_\n`;
        msg += `📊 Digite *resumo* para ver seu saldo atualizado.`;
        await this.enviar(remoteJid, msg);
      }
    } else {
      await this.enviar(remoteJid,
        `❓ Não entendi essa mensagem como uma transação financeira.\n\n` +
        `Tente algo como:\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n• _Conta de luz 120 reais_\n\n` +
        `Ou envie uma *foto* de nota fiscal/comprovante, ou um *áudio* descrevendo o gasto.\n\n` +
        `Digite *ajuda* para mais opções.`
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // AGENDA
  // ────────────────────────────────────────────────────────────────────────

  async interpretarCompromisso(texto) {
    const gatilho = /\b(compromisso|reunião|reuniao|consulta|dentista|médico|medico|agenda|lembr[ae]|amanhã|amanha|semana que vem|próxim[ao]|proxim[ao]|às \d|as \d|[\d]+h\d*|dia \d|lembra de|não esquecer|nao esquecer)\b/i;
    if (!gatilho.test(texto)) return null;

    const antiGatilho = /\b(gastei|paguei|comprei|recebi|deve|me deve|salário|salario)\b/i;
    if (antiGatilho.test(texto)) return null;

    if (!process.env.OPENAI_API_KEY) return null;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dataHoje = agora.toISOString().split('T')[0];
    const horaAtual = agora.toTimeString().slice(0, 5);

    const systemPrompt = SYSTEM_PROMPT_AGENDA
      .replace('{DATA_HOJE}', dataHoje)
      .replace('{HORA_ATUAL}', horaAtual);

    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 200, temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: texto },
        ],
      }, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      const conteudo = resp.data.choices[0].message.content.trim();
      if (!conteudo || conteudo === 'null') return null;
      const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
      if (parsed?.tipo === 'compromisso' && parsed.titulo && parsed.data_hora) return parsed;
      return null;
    } catch (err) {
      console.warn('Erro ao interpretar compromisso:', err.message);
      return null;
    }
  }

  async registrarCompromisso(remoteJid, usuarioId, compromisso, textoOriginal) {
    await this._garantirTabelaAgenda();

    let idCurto;
    let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM agenda WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
      tentativas++;
    } while (tentativas < 20);

    const dataHoraStr = compromisso.data_hora;
    const dataHora = new Date(dataHoraStr.replace(' ', 'T') + ':00-03:00');

    const { rows } = await db.query(
      `INSERT INTO agenda (usuario_id, titulo, data_hora, lembrar_antes, local, notas, id_curto, origem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'whatsapp')
       RETURNING id`,
      [usuarioId, compromisso.titulo, dataHora.toISOString(), compromisso.lembrar_antes || 30,
       compromisso.local || null, compromisso.notas || null, idCurto]
    );
    const agendaId = rows[0].id;

    // ── Sincroniza com Google Calendar ─────────────────────────────────────
    const googleEventId = await gcal.criarEvento(usuarioId, {
      titulo:       compromisso.titulo,
      dataHora:     dataHora.toISOString(),
      lembrarAntes: compromisso.lembrar_antes || 30,
      local:        compromisso.local || null,
      notas:        compromisso.notas || null,
    });
    if (googleEventId) {
      await db.query(
        `UPDATE agenda SET google_event_id = $1 WHERE id = $2`,
        [googleEventId, agendaId]
      );
    }

    const dataFmt = dataHora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
    const horaFmt = dataHora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const lembrarLabel = (compromisso.lembrar_antes || 30) >= 60
      ? `${(compromisso.lembrar_antes || 30) / 60}h antes`
      : `${compromisso.lembrar_antes || 30} minutos antes`;

    let msg = `📅 *Compromisso agendado!*\n\n`;
    msg += `📌 *${compromisso.titulo}*\n`;
    msg += `📅 Data: *${dataFmt}*\n`;
    msg += `🕐 Hora: *${horaFmt}*\n`;
    if (compromisso.local) msg += `📍 Local: ${compromisso.local}\n`;
    if (compromisso.notas) msg += `📝 Notas: ${compromisso.notas}\n`;
    msg += `🔔 Lembrete: ${lembrarLabel}\n`;
    if (googleEventId) msg += `🗓️ Sincronizado com Google Calendar ✅\n`;
    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔖 ID: *${idCurto}*\n\n`;
    msg += `❌ Para cancelar:\n_"cancelar compromisso ${idCurto}"_\n\n`;
    msg += `📋 Ver todos: _"agenda"_`;

    await this.enviar(remoteJid, msg);
  }

  async enviarAgenda(remoteJid, usuarioId) {
    await this._garantirTabelaAgenda();

    const { rows } = await db.query(
      `SELECT id_curto, titulo, data_hora, local, notas, lembrar_antes, lembrete_enviado
       FROM agenda
       WHERE usuario_id = $1 AND cancelado = false AND data_hora >= NOW() - INTERVAL '1 hour'
       ORDER BY data_hora ASC
       LIMIT 10`,
      [usuarioId]
    );

    if (rows.length === 0) {
      return this.enviar(remoteJid,
        `📅 *Sua agenda está vazia!*\n\n` +
        `Para adicionar um compromisso, diga:\n` +
        `_"Tenho reunião amanhã às 10h"_\n` +
        `_"Consulta médica dia 20 às 14h"_\n` +
        `_"Lembra de pagar o aluguel dia 5"_`
      );
    }

    const agora = new Date();
    let msg = `📅 *Seus Compromissos*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const comp of rows) {
      const dataHora = new Date(comp.data_hora);
      const dataFmt = dataHora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      const horaFmt = dataHora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const diffMin = Math.round((dataHora - agora) / 60000);

      let statusEmoji = '📌';
      let tempoLabel = '';
      if (diffMin < 0) {
        statusEmoji = '✅';
        tempoLabel = ` _(já passou)_`;
      } else if (diffMin < 60) {
        statusEmoji = '🟡';
        tempoLabel = ` _(em ${diffMin}min)_`;
      } else if (diffMin < 1440) {
        statusEmoji = '🔵';
        tempoLabel = ` _(em ${Math.round(diffMin / 60)}h)_`;
      }

      msg += `${statusEmoji} *${comp.titulo}*${tempoLabel}\n`;
      msg += `   📅 ${dataFmt} às ${horaFmt}`;
      if (comp.local) msg += ` | 📍 ${comp.local}`;
      msg += `\n   🔖 *${comp.id_curto}*\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `❌ Para cancelar: _"cancelar compromisso [ID]"_`;

    await this.enviar(remoteJid, msg);
  }

  async cancelarCompromisso(remoteJid, usuarioId, idCurto) {
    const { rows } = await db.query(
      `UPDATE agenda SET cancelado = true
       WHERE usuario_id = $1 AND UPPER(id_curto) = $2 AND cancelado = false
       RETURNING titulo, data_hora, google_event_id`,
      [usuarioId, idCurto]
    );

    if (rows.length === 0) {
      return this.enviar(remoteJid,
        `❌ Compromisso *${idCurto}* não encontrado ou já cancelado.\n\nDigite _"agenda"_ para ver os ativos.`
      );
    }

    const comp = rows[0];

    // ── Remove do Google Calendar ──────────────────────────────────────────
    if (comp.google_event_id) {
      await gcal.cancelarEvento(usuarioId, comp.google_event_id);
    }

    const dataHora = new Date(comp.data_hora);
    const dataFmt  = dataHora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaFmt  = dataHora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

    await this.enviar(remoteJid,
      `🗑️ *Compromisso cancelado!*\n\n` +
      `📌 ${comp.titulo}\n` +
      `📅 ${dataFmt} às ${horaFmt}\n\n` +
      `Digite _"agenda"_ para ver os demais.`
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // DÍVIDAS A RECEBER
  // ────────────────────────────────────────────────────────────────────────

  async interpretarDivida(texto) {
    const gatilho = /\b(me deve|deve(?:r)?|emprest(?:ei|ou)|devolver|vai me pagar|vai pagar|pagar.*dia|pagar.*semana|pagar.*m[eê]s)\b/i;
    if (!gatilho.test(texto)) return null;
    const falsoPositivo = /\beu devo\b|\bdevo\b/i;
    if (falsoPositivo.test(texto) && !/me deve/i.test(texto)) return null;
    if (!process.env.OPENAI_API_KEY) return null;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dataHoje = agora.toISOString().split('T')[0];
    const anoAtual = agora.getFullYear().toString();
    const systemPromptDivida = SYSTEM_PROMPT_DIVIDA
      .replace(/{DATA_HOJE}/g, dataHoje)
      .replace(/{ANO_ATUAL}/g, anoAtual);

    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 150, temperature: 0,
        messages: [
          { role: 'system', content: systemPromptDivida },
          { role: 'user', content: texto },
        ],
      }, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const conteudo = resp.data.choices[0].message.content.trim();
      if (!conteudo || conteudo === 'null') return null;
      const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
      if (parsed?.tipo === 'divida_receber' && parsed.devedor && parsed.valor > 0) return parsed;
      return null;
    } catch (err) {
      console.warn('Erro ao interpretar dívida:', err.message);
      return null;
    }
  }

  async registrarDividaReceber(remoteJid, usuarioId, divida, textoOriginal) {
    await this._garantirTabelaDividas();
    let idCurto; let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM dividas_receber WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
      tentativas++;
    } while (tentativas < 20);

    const vencimento = divida.data_vencimento || null;
    const vencimentoFmt = vencimento
      ? new Date(vencimento + 'T12:00:00').toLocaleDateString('pt-BR')
      : 'Não definido';

    await db.query(
      `INSERT INTO dividas_receber (usuario_id, devedor, descricao, valor, data_vencimento, origem, mensagem_raw, id_curto)
       VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6, $7)`,
      [usuarioId, divida.devedor, divida.descricao || `${divida.devedor} te deve`, divida.valor, vencimento, textoOriginal, idCurto]
    );

    if (this.onNovaTransacao) this.onNovaTransacao({ tipo: 'divida_receber', valor: divida.valor, descricao: `${divida.devedor} te deve`, origem: 'whatsapp' });

    const valorFmt = divida.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    await this.enviar(remoteJid,
      `💸 *Dívida registrada!*\n\n` +
      `👤 Devedor: *${divida.devedor}*\n` +
      `💵 Valor: *${valorFmt}*\n` +
      `📅 Vencimento: ${vencimentoFmt}\n` +
      `📋 Descrição: ${divida.descricao || '—'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔖 ID: *${idCurto}*\n\n` +
      `✅ Quando receber, diga:\n_"recebido ${idCurto}"_\n\n` +
      `📋 Ver todas: _"a receber"_`
    );
  }

  async enviarDividasReceber(remoteJid, usuarioId) {
    await this._garantirTabelaDividas();
    const { rows } = await db.query(
      `SELECT id_curto, devedor, valor, data_vencimento, criado_em FROM dividas_receber
       WHERE usuario_id = $1 AND status = 'pendente'
       ORDER BY data_vencimento ASC NULLS LAST, criado_em DESC`,
      [usuarioId]
    );
    const { rows: totais } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor END), 0) AS pendente,
         COALESCE(SUM(CASE WHEN status = 'recebido'
                            AND EXTRACT(MONTH FROM data_recebimento) = EXTRACT(MONTH FROM NOW())
                            AND EXTRACT(YEAR  FROM data_recebimento) = EXTRACT(YEAR  FROM NOW())
                           THEN valor END), 0) AS recebido_mes
       FROM dividas_receber WHERE usuario_id = $1`,
      [usuarioId]
    );
    const fmt = (v) => parseFloat(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    if (rows.length === 0) {
      return this.enviar(remoteJid,
        `✅ *Nenhuma dívida pendente!*\n\n💰 Já recebido este mês: *${fmt(totais[0].recebido_mes)}*\n\nPara registrar:\n_"Bruno me deve 50 reais, paga dia 30"_`
      );
    }
    let msg = `💸 *Dívidas a Receber*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 Total pendente: *${fmt(totais[0].pendente)}*\n✅ Recebido este mês: *${fmt(totais[0].recebido_mes)}*\n\n`;
    for (const d of rows) {
      let vencLabel = '📅 Sem data definida'; let alertEmoji = '';
      if (d.data_vencimento) {
        const venc = new Date(d.data_vencimento + 'T12:00:00');
        const diffDias = Math.round((venc - hoje) / (1000 * 60 * 60 * 24));
        const dataFmt = venc.toLocaleDateString('pt-BR');
        if (diffDias < 0) { vencLabel = `📅 Venceu ${dataFmt} (${Math.abs(diffDias)}d atrás)`; alertEmoji = '🔴 '; }
        else if (diffDias === 0) { vencLabel = `📅 Vence HOJE`; alertEmoji = '🟡 '; }
        else if (diffDias <= 3) { vencLabel = `📅 Vence em ${diffDias}d — ${dataFmt}`; alertEmoji = '🟡 '; }
        else { vencLabel = `📅 ${dataFmt}`; }
      }
      msg += `${alertEmoji}👤 *${d.devedor}* — ${fmt(d.valor)}\n   ${vencLabel} | 🔖 *${d.id_curto}*\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n✅ Para marcar como recebido:\n_"recebido [ID]"_ — Ex: _recebido A3B_`;
    await this.enviar(remoteJid, msg);
  }

  async quitarDivida(remoteJid, usuarioId, idCurto) {
    const { rows } = await db.query(
      `UPDATE dividas_receber SET status = 'recebido', data_recebimento = CURRENT_DATE
       WHERE usuario_id = $1 AND UPPER(id_curto) = $2 AND status = 'pendente' RETURNING *`,
      [usuarioId, idCurto]
    );
    if (rows.length === 0)
      return this.enviar(remoteJid, `❌ Dívida *${idCurto}* não encontrada ou já quitada.\n\nDigite _"a receber"_ para ver as pendentes.`);
    const d = rows[0];
    const contaRes = await db.query(`SELECT id, nome FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1`, [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;
    const contaNome = contaRes.rows[0]?.nome || 'carteira';
    await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, conta_id, data_vencimento, data_pagamento, pago, origem)
       VALUES ($1, 'receita', $2, $3, $4, CURRENT_DATE, CURRENT_DATE, true, 'whatsapp')`,
      [usuarioId, `Recebido de ${d.devedor}`, d.valor, contaId]
    );
    if (contaId) await db.query(`UPDATE contas SET saldo = saldo + $1 WHERE id = $2`, [d.valor, contaId]);
    const fmt = (v) => parseFloat(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    await this.enviar(remoteJid,
      `✅ *Recebimento confirmado!*\n\n👤 Devedor: *${d.devedor}*\n💵 Valor: *${fmt(d.valor)}*\n\n` +
      `💰 Receita de *${fmt(d.valor)}* registrada!\n🏦 Conta: ${contaNome}\n\n` +
      `Digite _"a receber"_ para ver as demais pendentes.`
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // CATEGORIAS
  // ────────────────────────────────────────────────────────────────────────

  async iniciarFluxoNovaCategoria(remoteJid, telefone) {
    this._estadosCategoriaFluxo.set(telefone, { etapa: 'aguardando_nome' });
    await this.enviar(remoteJid, `➕ *Nova Categoria*\n\nQual será o nome da nova categoria?\n\n_Ex: Pets, Jogos, Presente_`);
  }

  async _continuarFluxoCategoria(telefone, remoteJid, texto) {
    const estado = this._estadosCategoriaFluxo.get(telefone);
    if (!estado) return;
    if (textoLower(texto) === 'cancelar' || textoLower(texto) === 'sair') {
      this._estadosCategoriaFluxo.delete(telefone);
      return this.enviar(remoteJid, '❌ Criação de categoria cancelada.');
    }
    const sessao = await this._buscarSessao(telefone, remoteJid);
    if (!sessao) { this._estadosCategoriaFluxo.delete(telefone); return; }
    if (estado.etapa === 'aguardando_nome') {
      const nomeCategoria = texto.trim();
      if (nomeCategoria.length < 2 || nomeCategoria.length > 50)
        return this.enviar(remoteJid, '⚠️ Nome inválido. Use entre 2 e 50 caracteres.');
      estado.nomeCategoria = nomeCategoria;
      estado.etapa = 'aguardando_confirmacao';
      this._estadosCategoriaFluxo.set(telefone, estado);
      await this.enviar(remoteJid, `📋 Confirma a criação da categoria *"${nomeCategoria}"*?\n\nResponda *sim* para confirmar ou *não* para cancelar.`);
    } else if (estado.etapa === 'aguardando_confirmacao') {
      const resp = texto.toLowerCase().trim();
      if (['sim', 's', 'yes', 'confirmar'].includes(resp)) {
        try {
          await db.query(`INSERT INTO categorias (usuario_id, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [sessao.usuarioId, estado.nomeCategoria]);
          this._estadosCategoriaFluxo.delete(telefone);
          await this.enviar(remoteJid, `✅ Categoria *"${estado.nomeCategoria}"* criada com sucesso!\n\nAgora você pode usá-la ao registrar transações.`);
        } catch (err) {
          console.error('Erro ao criar categoria:', err.message);
          this._estadosCategoriaFluxo.delete(telefone);
          await this.enviar(remoteJid, '❌ Erro ao criar categoria. Tente novamente.');
        }
      } else {
        this._estadosCategoriaFluxo.delete(telefone);
        await this.enviar(remoteJid, '❌ Criação de categoria cancelada.');
      }
    }
  }

  async enviarCategorias(remoteJid, usuarioId) {
    await this._garantirCategoriasPadrao(usuarioId);
    const { rows } = await db.query(
      `SELECT DISTINCT ON (LOWER(nome)) nome FROM categorias WHERE usuario_id = $1 ORDER BY LOWER(nome) ASC`,
      [usuarioId]
    );
    if (rows.length === 0) return this.enviar(remoteJid, '📂 Você ainda não tem categorias cadastradas.');
    let msg = `📂 *Suas Categorias:*\n\n`;
    for (const row of rows) {
      const emoji = EMOJI_CATEGORIA[row.nome] || '📦';
      msg += `${emoji} ${row.nome}\n`;
    }
    msg += `\n➕ Para criar uma nova categoria, envie:\n_nova categoria_`;
    await this.enviar(remoteJid, msg);
  }

  // ────────────────────────────────────────────────────────────────────────
  // TRANSAÇÕES
  // ────────────────────────────────────────────────────────────────────────

  async excluirUltimaTransacao(remoteJid, usuarioId) {
    try {
      const { rows } = await db.query(
        `SELECT id, descricao, valor, tipo, conta_id, id_curto FROM transacoes WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
        [usuarioId]
      );
      if (rows.length === 0) return this.enviar(remoteJid, '📭 Você não tem nenhuma transação registrada para excluir.');
      const tx = rows[0];
      const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      if (tx.conta_id) {
        const sinal = tx.tipo === 'receita' ? -1 : 1;
        await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * tx.valor, tx.conta_id]);
      }
      await db.query(`DELETE FROM transacoes WHERE id = $1`, [tx.id]);
      await this.enviar(remoteJid,
        `🗑️ *Última transação excluída!*\n\n📋 Descrição: ${tx.descricao}\n💵 Valor: ${fmt(tx.valor)}\n` +
        (tx.id_curto ? `🔖 ID: ${tx.id_curto}\n` : '') +
        `\n✅ Saldo atualizado.\n\nDigite *resumo* para ver seu saldo atual.`
      );
    } catch (err) {
      console.error('Erro ao excluir última transação:', err.message);
      await this.enviar(remoteJid, '❌ Erro ao excluir transação. Tente novamente.');
    }
  }

  async excluirTransacao(remoteJid, usuarioId, idCurto) {
    try {
      await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
      const { rows } = await db.query(
        `SELECT id, descricao, valor, tipo, conta_id FROM transacoes WHERE usuario_id = $1 AND UPPER(id_curto) = $2`,
        [usuarioId, idCurto]
      );
      if (rows.length === 0) {
        return this.enviar(remoteJid,
          `❌ Transação *${idCurto}* não encontrada.\n\nDicas:\n• Verifique o ID\n• Digite *histórico* para ver suas últimas\n• Para excluir a última: _excluir última_`
        );
      }
      const tx = rows[0];
      const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      if (tx.conta_id) {
        const sinal = tx.tipo === 'receita' ? -1 : 1;
        await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * tx.valor, tx.conta_id]);
      }
      await db.query(`DELETE FROM transacoes WHERE id = $1`, [tx.id]);
      await this.enviar(remoteJid,
        `🗑️ *Transação excluída com sucesso!*\n\n📋 Descrição: ${tx.descricao}\n💵 Valor: ${fmt(tx.valor)}\n🔖 ID: ${idCurto}\n\n✅ Saldo atualizado.\n\nDigite *resumo* para ver seu saldo atual.`
      );
    } catch (err) {
      console.error('Erro ao excluir transação:', err.message);
      await this.enviar(remoteJid, '❌ Erro ao excluir transação. Tente novamente.');
    }
  }

  async enviarUltimasTransacoes(remoteJid, usuarioId) {
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
    const { rows } = await db.query(
      `SELECT t.id_curto, t.descricao, t.valor, t.tipo, c.nome AS categoria, t.data_pagamento
       FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1 ORDER BY t.criado_em DESC LIMIT 5`,
      [usuarioId]
    );
    if (rows.length === 0) return this.enviar(remoteJid, '📭 Nenhuma transação registrada ainda.');
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    let msg = `🕐 *Últimas transações:*\n\n`;
    for (const tx of rows) {
      const emoji = tx.tipo === 'despesa' ? '💸' : '💰';
      const data = tx.data_pagamento
        ? new Date(tx.data_pagamento).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : '—';
      msg += `${emoji} *${tx.descricao}* — ${fmt(tx.valor)}\n`;
      msg += `   🏷️ ${tx.categoria || 'Outros'} | 📅 ${data}`;
      if (tx.id_curto) msg += ` | 🔖 *${tx.id_curto}*`;
      msg += `\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n🗑️ *Para excluir:*\n• _excluir última_ — remove a mais recente\n• _excluir [ID]_ — Ex: excluir A3B`;
    await this.enviar(remoteJid, msg);
  }

  async gerarEEnviarRelatorioPDF(remoteJid, usuarioId, nome) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    await this.enviar(remoteJid, `📄 Gerando seu relatório de *${mesesNome[mes-1]}/${ano}*...\n\nAguarde alguns instantes ⏳`);
    try {
      limparPdfsAntigos();
      const { outputPath, dados } = await gerarRelatorio(usuarioId, mes, ano);
      const totalTx = dados.transacoes.length;
      if (totalTx === 0)
        return this.enviar(remoteJid, `📭 Não há transações em *${mesesNome[mes-1]}/${ano}* para gerar relatório.\n\nComece registrando um gasto!`);
      const pdfBuffer = fs.readFileSync(outputPath);
      const recebido = parseFloat(dados.totais.recebido);
      const pago = parseFloat(dados.totais.pago);
      const saldo = recebido - pago;
      const sinalSaldo = saldo >= 0 ? '+' : '';
      await this.socket.sendMessage(remoteJid, {
        document: pdfBuffer,
        fileName: `Relatorio_Seu_Bolso_${mesesNome[mes-1]}_${ano}.pdf`,
        mimetype: 'application/pdf',
        caption:
          `📊 *Relatório — ${mesesNome[mes-1]}/${ano}*\n\n` +
          `📋 ${totalTx} transações\n` +
          `💸 Despesas: ${pago.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })}\n` +
          `💰 Receitas: ${recebido.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })}\n` +
          `📈 Saldo: ${sinalSaldo}${saldo.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })}\n\n` +
          `🌐 Painel: *https://www.seusecretario.com.br/painel*`,
      });
      try { fs.unlinkSync(outputPath); } catch {}
    } catch (err) {
      console.error('Erro ao gerar PDF:', err.message);
      await this.enviar(remoteJid, `❌ Não consegui gerar o PDF agora.\n\nTente novamente ou acesse *https://www.seusecretario.com.br/painel*`);
    }
  }

  async _transcreverAudio(msg) {
    if (!process.env.OPENAI_API_KEY) { console.warn('OPENAI_API_KEY não definida'); return null; }
    let tmpFile = null;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      tmpFile = path.join(TMP_DIR, `audio_${Date.now()}.ogg`);
      fs.writeFileSync(tmpFile, buffer);
      const form = new FormData();
      form.append('file', fs.createReadStream(tmpFile), { filename: 'audio.ogg', contentType: 'audio/ogg' });
      form.append('model', 'whisper-1');
      form.append('language', 'pt');
      form.append('response_format', 'text');
      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 30000,
      });
      return typeof resp.data === 'string' ? resp.data.trim() : resp.data?.text?.trim() || null;
    } catch (err) {
      console.error('Erro ao transcrever áudio:', err.response?.data || err.message);
      return null;
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch {} }
    }
  }

  async _analisarImagem(msg) {
    if (!process.env.OPENAI_API_KEY) { console.warn('OPENAI_API_KEY não definida'); return null; }
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const base64 = buffer.toString('base64');
      const mimetype = msg.message.imageMessage?.mimetype || 'image/jpeg';
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 300, temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}`, detail: 'low' } },
            { type: 'text', text: 'Analise esta imagem e extraia a transação financeira.' },
          ]},
        ],
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
      const conteudo = resp.data.choices[0].message.content.trim();
      if (conteudo === 'null' || !conteudo) return null;
      const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      console.error('Erro ao analisar imagem:', err.response?.data || err.message);
      return null;
    }
  }

  // ── Mapeamento local de palavras → categoria (fallback sem API) ──────────
  _detectarCategoria(descricao) {
    const d = (descricao || '').toLowerCase();
    const mapa = [
      { cat: 'Alimentação',            palavras: ['comida','almoço','almoco','jantar','cafe','café','lanche','restaurante','ifood','delivery','pizza','hamburguer','burguer','sushi','marmita','refeição','refeicao','padaria','pastel','açaí','acai','sorvete','doceria','coxinha','snack'] },
      { cat: 'Transporte',             palavras: ['uber','99','taxi','táxi','ônibus','onibus','metro','metrô','gasolina','combustivel','combustível','passagem','estacionamento','pedagio','pedágio','mototaxi','bicicleta','trem'] },
      { cat: 'Mercado',                palavras: ['mercado','supermercado','feira','hortifruti','atacado','atacarejo','compras de casa','compras casa'] },
      { cat: 'Saúde',                  palavras: ['farmácia','farmacia','médico','medico','consulta','remédio','remedio','academia','plano de saúde','plano saude','dentista','hospital','exame','vacina','fisioterapia','psicólogo','psicologo'] },
      { cat: 'Assinatura',             palavras: ['netflix','spotify','amazon','disney','youtube premium','hbo','globoplay','deezer','apple music','mensalidade','assinatura','clube','plano'] },
      { cat: 'Educação',               palavras: ['curso','escola','faculdade','universidade','livro','treinamento','capacitação','capacitacao','aula','udemy','alura','estudo'] },
      { cat: 'Casa',                   palavras: ['aluguel','condomínio','condominio','água','agua','luz','energia','internet','gás','gas','móvel','movel','reforma','manutenção','manutencao','prestação','prestacao','iptu'] },
      { cat: 'Lazer e Entretenimento', palavras: ['cinema','show','bar','balada','jogo','viagem','passeio','festa','ingresso','teatro','parque'] },
      { cat: 'Vestuário',              palavras: ['roupa','sapato','tênis','tenis','calçado','calcado','acessório','acessorio','bolsa','camiseta','calça','calca','vestido'] },
      { cat: 'Cuidados pessoais',      palavras: ['salão','salao','barbearia','estética','estetica','perfume','cosméticos','cosmeticos','higiene','cabelo','maquiagem','manicure','pedicure'] },
      { cat: 'Pets',                   palavras: ['ração','racao','veterinário','veterinario','banho e tosa','pet shop','pet','animal'] },
      { cat: 'Doações',                palavras: ['doação','doacao','caridade','esmola','contribuição','contribuicao','solidário','solidario'] },
      { cat: 'Impostos',               palavras: ['ipva','iptu','imposto','taxa','multa','tributo','ir ','irpf'] },
      { cat: 'Salário',                palavras: ['salário','salario','holerite','pró-labore','prolabore','pagamento recebido'] },
      { cat: 'Viagem',                 palavras: ['hotel','hospedagem','passagem aérea','passagem aerea','turismo','airbnb','hostel'] },
    ];
    for (const { cat, palavras } of mapa) {
      if (palavras.some(p => d.includes(p))) return cat;
    }
    return 'Outros';
  }

  // ── interpretarTransacao — retorna sempre null | array ─────────────────
  async interpretarTransacao(texto) {
    if (process.env.OPENAI_API_KEY) {
      try {
        const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o-mini', max_tokens: 500, temperature: 0,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: texto }],
        }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
        const conteudo = resp.data.choices[0].message.content.trim();
        if (conteudo && conteudo !== 'null') {
          const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
          if (parsed) return Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch (err) {
        console.warn('GPT indisponível, usando fallback regex:', err.response?.data?.error?.message || err.message);
      }
    }

    const padraoMultiplo =
      /(?:(?:gastei|paguei|comprei|saiu|debitou?|recebi|ganhei|entrou|creditou?)\s+)?(?:R\$\s*)?(\d+(?:[,.]\d+)?)\s*(?:reais?)?\s*(?:de\s+|no?\s+|na\s+|em\s+|com\s+)([^0-9\n,]+?)(?=\s*[,e]\s*(?:(?:mais\s+)?(?:\d|R\$|gastei|paguei|recebi))|$)/gi;

    const matches = [...texto.matchAll(padraoMultiplo)];
    if (matches.length >= 2) {
      const verbosReceita = /recebi|ganhei|entrou|creditou/i;
      const resultados = matches.map(m => {
        const descricao = m[2].trim().replace(/[,;.]+$/, '');
        return {
          tipo: verbosReceita.test(texto.slice(0, m.index + 20)) ? 'receita' : 'despesa',
          valor: parseFloat(m[1].replace(',', '.')),
          descricao,
          categoria: this._detectarCategoria(descricao),
        };
      }).filter(t => t.valor > 0 && t.descricao.length > 0);
      if (resultados.length >= 2) return resultados;
    }

    const padroesGasto = [
      /(?:gastei|paguei|comprei|saiu|debitou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|no?\s+|na\s+|em\s+|com\s+)?(.*)/i,
      /(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?)?\s*(?:de\s+|no?\s+|na\s+|em\s+)(.+)/i,
    ];
    const padroesReceita = [
      /(?:recebi|ganhei|entrou|creditou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|do?\s+|da\s+)?(.*)/i,
    ];
    for (const p of padroesGasto) {
      const m = texto.match(p);
      if (m && parseFloat(m[1].replace(',', '.')) > 0) {
        const descricao = m[2]?.trim() || 'Gasto';
        return [{ tipo: 'despesa', valor: parseFloat(m[1].replace(',', '.')), descricao, categoria: this._detectarCategoria(descricao) }];
      }
    }
    for (const p of padroesReceita) {
      const m = texto.match(p);
      if (m && parseFloat(m[1].replace(',', '.')) > 0) {
        const descricao = m[2]?.trim() || 'Receita';
        return [{ tipo: 'receita', valor: parseFloat(m[1].replace(',', '.')), descricao, categoria: this._detectarCategoria(descricao) }];
      }
    }

    return null;
  }

  async registrarTransacao(remoteJid, usuarioId, transacao, textoOriginal) {
    await this._garantirCategoriasPadrao(usuarioId);
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});

    let categoriaId = null;
    let categoriaNome = transacao.categoria || 'Outros';
    if (categoriaNome) {
      const catRes = await db.query(
        `SELECT id, nome FROM categorias WHERE (usuario_id = $1 OR usuario_id IS NULL) AND LOWER(nome) = LOWER($2) LIMIT 1`,
        [usuarioId, categoriaNome]
      );
      if (catRes.rows.length > 0) { categoriaId = catRes.rows[0].id; categoriaNome = catRes.rows[0].nome; }
    }

    const contaRes = await db.query('SELECT id, nome FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1', [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;
    const contaNome = contaRes.rows[0]?.nome || 'carteira';

    let idCurto; let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM transacoes WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
      tentativas++;
    } while (tentativas < 20);

    const dataHoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });

    const { rows } = await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, categoria_id, conta_id, data_vencimento, data_pagamento, pago, origem, mensagem_raw, id_curto)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE,true,'whatsapp',$7,$8) RETURNING id`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor, categoriaId, contaId, textoOriginal, idCurto]
    );

    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * transacao.valor, contaId]);
    }

    if (this.onNovaTransacao) this.onNovaTransacao({
      id: rows[0].id, idCurto,
      tipo: transacao.tipo, valor: transacao.valor,
      descricao: transacao.descricao, categoria: categoriaNome, origem: 'whatsapp',
    });

    const emojiTipo   = transacao.tipo === 'despesa' ? '🔴' : '🟢';
    const labelTipo   = transacao.tipo === 'despesa' ? 'Despesa' : 'Receita';
    const emojiCat    = EMOJI_CATEGORIA[categoriaNome] || '📦';
    const valorFmt    = transacao.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    await this.enviar(remoteJid,
      `✅ *Transação registrada com sucesso!*\n\n` +
      `📋 Descrição: ${transacao.descricao}\n💵 Valor: ${valorFmt}\n🔄 Tipo: ${emojiTipo} ${labelTipo}\n` +
      `${emojiCat} Categoria: ${categoriaNome}\n🏦 Conta: ${contaNome}\n📅 Data: ${dataHoje}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔖 ID: *${idCurto}*\n\n` +
      `🗑️ Errou? Diga: _"excluir ${idCurto}"_ ou _"excluir última"_`
    );
  }

  async registrarTransacaoSilencioso(remoteJid, usuarioId, transacao, textoOriginal) {
    await this._garantirCategoriasPadrao(usuarioId);
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});

    let categoriaId = null;
    let categoriaNome = transacao.categoria || 'Outros';
    if (categoriaNome) {
      const catRes = await db.query(
        `SELECT id, nome FROM categorias WHERE (usuario_id = $1 OR usuario_id IS NULL) AND LOWER(nome) = LOWER($2) LIMIT 1`,
        [usuarioId, categoriaNome]
      );
      if (catRes.rows.length > 0) { categoriaId = catRes.rows[0].id; categoriaNome = catRes.rows[0].nome; }
    }

    const contaRes = await db.query('SELECT id, nome FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1', [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;

    let idCurto; let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM transacoes WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
      tentativas++;
    } while (tentativas < 20);

    const { rows } = await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, categoria_id, conta_id, data_vencimento, data_pagamento, pago, origem, mensagem_raw, id_curto)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE,true,'whatsapp',$7,$8) RETURNING id`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor, categoriaId, contaId, textoOriginal, idCurto]
    );

    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * transacao.valor, contaId]);
    }

    if (this.onNovaTransacao) this.onNovaTransacao({ id: rows[0].id, idCurto, tipo: transacao.tipo, valor: transacao.valor, descricao: transacao.descricao, categoria: categoriaNome, origem: 'whatsapp' });

    return idCurto;
  }

  // ────────────────────────────────────────────────────────────────────────
  // RESUMO
  // ────────────────────────────────────────────────────────────────────────
  async enviarResumo(remoteJid, usuarioId, nome) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = mesesNome[mes - 1];

    const { rows: totais } = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN tipo='receita' AND pago=true THEN valor END), 0) AS recebido,
        COALESCE(SUM(CASE WHEN tipo='receita' AND pago=false THEN valor END), 0) AS a_receber,
        COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=true THEN valor END), 0) AS pago,
        COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=false THEN valor END), 0) AS a_pagar
       FROM transacoes
       WHERE usuario_id = $1
         AND EXTRACT(MONTH FROM COALESCE(data_pagamento, data_vencimento)) = $2
         AND EXTRACT(YEAR FROM COALESCE(data_pagamento, data_vencimento)) = $3`,
      [usuarioId, mes, ano]
    );

    const { rows: catDespesas } = await db.query(
      `SELECT c.nome, SUM(t.valor) AS total FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1 AND t.tipo = 'despesa'
         AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
         AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
       GROUP BY c.nome ORDER BY total DESC LIMIT 5`,
      [usuarioId, mes, ano]
    );

    const { rows: catReceitas } = await db.query(
      `SELECT c.nome, SUM(t.valor) AS total FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1 AND t.tipo = 'receita'
         AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
         AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
       GROUP BY c.nome ORDER BY total DESC LIMIT 5`,
      [usuarioId, mes, ano]
    );

    const { rows: dividasPend } = await db.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor), 0) AS total FROM dividas_receber WHERE usuario_id = $1 AND status = 'pendente'`,
      [usuarioId]
    ).catch(() => ({ rows: [{ qtd: 0, total: 0 }] }));

    const { rows: proximosComps } = await db.query(
      `SELECT titulo, data_hora FROM agenda
       WHERE usuario_id = $1 AND cancelado = false AND data_hora >= NOW()
       ORDER BY data_hora ASC LIMIT 3`,
      [usuarioId]
    ).catch(() => ({ rows: [] }));

    const recebido = parseFloat(totais[0].recebido);
    const aReceber = parseFloat(totais[0].a_receber);
    const pago     = parseFloat(totais[0].pago);
    const aPagar   = parseFloat(totais[0].a_pagar);
    const saldoDisponivel = recebido - pago;
    const saldoPrevisto   = (recebido + aReceber) - (pago + aPagar);
    const totalDespesas   = pago + aPagar;

    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const emojiSaldo = saldoDisponivel >= 0 ? '💚' : '🔴';

    let msg = `🏦 *Resumo Financeiro - ${nomeMes}/${ano}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `${emojiSaldo} Disponível: *${fmt(saldoDisponivel)}*\n`;
    msg += `📈 Previsto: *${fmt(saldoPrevisto)}* (até ${ultimoDia.toString().padStart(2,'0')}/${mes.toString().padStart(2,'0')})\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n📥 *Receitas*\n\n`;
    msg += `✅ Recebido: *${fmt(recebido)}*\n⏳ A receber: *${fmt(aReceber)}*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n📤 *Despesas*\n\n`;
    msg += `💳 Pago: *${fmt(pago)}*\n⏳ A pagar: *${fmt(aPagar)}*\n\n`;

    if (catDespesas.length > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n📊 *Top Despesas por Categoria*\n\n`;
      for (const cat of catDespesas) {
        const catNome = cat.nome || 'Outros';
        const emoji = EMOJI_CATEGORIA[catNome] || '📦';
        const pct = totalDespesas > 0 ? ((parseFloat(cat.total) / totalDespesas) * 100).toFixed(1) : '0.0';
        msg += `${emoji} ${catNome} → *${fmt(parseFloat(cat.total))}* (${pct}%)\n`;
      }
      msg += `\n`;
    }

    if (catReceitas.length > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n💰 *Receitas por Categoria*\n\n`;
      for (const cat of catReceitas) {
        const catNome = cat.nome || 'Outros';
        const emoji = EMOJI_CATEGORIA[catNome] || '📦';
        msg += `${emoji} ${catNome} → *${fmt(parseFloat(cat.total))}*\n`;
      }
      msg += `\n`;
    }

    if (dividasPend[0] && parseInt(dividasPend[0].qtd) > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n💸 *Dívidas a Receber*\n\n`;
      msg += `👥 ${dividasPend[0].qtd} devedor(es) pendente(s)\n`;
      msg += `💰 Total: *${fmt(parseFloat(dividasPend[0].total))}*\n`;
      msg += `\nDigite _"a receber"_ para ver a lista.\n\n`;
    }

    if (proximosComps.length > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n📅 *Próximos Compromissos*\n\n`;
      for (const comp of proximosComps) {
        const dh = new Date(comp.data_hora);
        const dataFmt = dh.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
        const horaFmt = dh.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        msg += `📌 *${comp.titulo}* — ${dataFmt} às ${horaFmt}\n`;
      }
      msg += `\nDigite _"agenda"_ para ver todos.\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n📄 *Quer um relatório em PDF?*\nDigite: _pdf_\n\n`;
    msg += `🌐 *Painel completo:*\nhttps://www.seusecretario.com.br/painel`;

    await this.enviar(remoteJid, msg);
  }

  // ────────────────────────────────────────────────────────────────────────
  // enviar
  // ────────────────────────────────────────────────────────────────────────
  async enviar(remoteJid, texto) {
    if (!this.socket || !this.conectado) { console.warn(`Bot desconectado, não enviou para ${remoteJid}`); return; }
    const jid = remoteJid.includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    try {
      await Promise.race([
        this.socket.sendMessage(jid, { text: texto, linkPreview: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
      ]);
    } catch (err) { console.warn(`Falha ao enviar para ${jid}: ${err.message}`); }
  }

  async enviarBoasVindasECapturarLid(telefone, usuarioId, nome) {
    if (!this.socket || !this.conectado) { console.warn('Bot desconectado'); return; }
    await this._garantirCategoriasPadrao(usuarioId);
    const jid = `55${telefone}@s.whatsapp.net`;
    try {
      const resultado = await Promise.race([
        this.socket.sendMessage(jid, { text: this.msgBemVindo(nome) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
      ]);
      const jidReal = resultado?.key?.remoteJid || resultado?.key?.participant || null;
      if (jidReal && jidReal.endsWith('@lid')) {
        lidCache.set(jidReal, telefone);
        await this._garantirTabelaLidMap();
        await db.query(`INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`, [jidReal, telefone]);
        await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});
        await db.query(`UPDATE sessoes_bot SET lid = $1 WHERE usuario_id = $2`, [jidReal, usuarioId]);
        console.log(`LID vinculado ao usuario ${usuarioId}: ${jidReal}`);
      }
      await new Promise(r => setTimeout(r, 2000));
      await Promise.race([
        this.socket.sendMessage(jid, { text: this.msgTutorial() }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
      ]);
    } catch (err) { console.warn(`Falha ao enviar boas-vindas para ${jid}:`, err.message); }
  }

  async reconectar() {
    this._tentativas = 0; this._reconectando = false;
    if (this._timerReconexao) { clearTimeout(this._timerReconexao); this._timerReconexao = null; }
    await this._fecharSocket();
    await this.iniciar();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Mensagens fixas
  // ────────────────────────────────────────────────────────────────────────
  msgBemVindo(nome) {
    return (
      `🎉 Olá, *${nome}*! Seja bem-vindo(a) ao *Seu Secretário*! 👋\n\n` +
      `🤖 Sou seu assistente pessoal. Estou aqui para te ajudar a organizar sua vida financeira, sua agenda e muito mais — tudo direto pelo WhatsApp, sem precisar abrir nenhum app!\n\n` +
      `Já deixei sua conta configurada e pronta para usar. Escreva *ajuda* que te ensino como usar 😊`
    );
  }

  msgTutorial() {
    return (
      `📚 *Como usar o Seu Secretário:*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💬 *1. Registre gastos e receitas:*\n\n` +
      `_"Gastei 35 no almoço"_\n` +
      `_"Paguei 120 de conta de luz"_\n` +
      `_"Recebi 3000 de salário"_\n` +
      `_"Gastei 50 com comida, 30 com uber e 10 no café"_ ← vários de uma vez!\n\n` +
      `🎤 *2. Ou mande um áudio* falando o gasto\n\n` +
      `📸 *3. Ou tire uma foto* da nota fiscal\n\n` +
      `💸 *4. Registre dívidas de terceiros:*\n\n` +
      `_"Bruno me deve 40 reais, paga dia 30"_\n\n` +
      `📅 *5. Agende compromissos:*\n\n` +
      `_"agendar Lucas para amanhã 12hs"_\n` +
      `_"agendar reunião amanhã às 10h"_\n` +
      `_"agendar consulta médica dia 20 às 14h no hospital"_\n` +
      `_"Tenho reunião amanhã às 10h"_ — forma livre\n` +
      `_"agendar lista de compromissos"_ — ver agenda\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *Comandos úteis:*\n\n` +
      `• *resumo* — Ver saldo e relatório do mês\n` +
      `• *histórico* — Ver últimas transações\n` +
      `• *agenda* — Ver seus compromissos\n` +
      `• *a receber* — Ver dívidas pendentes\n` +
      `• *categorias* — Ver suas categorias\n` +
      `• *pdf* — Baixar relatório em PDF\n` +
      `• *ajuda* — Ver todos os comandos\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 Painel completo: *https://www.seusecretario.com.br/painel*\n\n` +
      `Pode começar! Me manda seu primeiro gasto 👆`
    );
  }

  msgAjuda() {
    return (
      `🤖 *Comandos disponíveis:*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 *Registrar transações:*\n` +
      `_Gastei 50 no mercado_\n` +
      `_Recebi 3000 de salário_\n` +
      `_Gastei 50 com comida, 30 com uber_ ← vários!\n\n` +
      `🎤 *Áudio:* Mande um áudio falando o gasto\n` +
      `📸 *Foto:* Tire foto de nota fiscal\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 *Agenda:*\n` +
      `_"agendar Lucas para amanhã 12hs"_ — agenda\n` +
      `_"agendar reunião sexta às 14h"_ — agenda\n` +
      `_"agendar consulta médica dia 20 às 14h"_ — agenda\n` +
      `_"Tenho reunião amanhã às 10h"_ — forma livre\n` +
      `_agenda_ ou _"agendar lista de compromissos"_ — lista\n` +
      `_"cancelar compromisso [ID]"_ — cancela\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 *Dívidas a Receber:*\n` +
      `_"Bruno me deve 40, paga dia 30"_ — registra\n` +
      `_a receber_ — lista devedores\n` +
      `_"recebido [ID]"_ — quita e vira receita\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *resumo* — Saldo e relatório do mês\n` +
      `🕐 *histórico* — Últimas transações\n` +
      `📂 *categorias* — Suas categorias\n` +
      `➕ *nova categoria* — Adicionar categoria\n` +
      `📄 *pdf* — Relatório mensal em PDF\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🗑️ *Excluir transações:*\n` +
      `_excluir última_ — remove a mais recente\n` +
      `_excluir [ID]_ — Ex: excluir A3B\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 Painel: *https://www.seusecretario.com.br/dashboard*`
    );
  }
}

function textoLower(t) { return (t || '').toLowerCase().trim(); }

module.exports = BotSeuSecretario;
