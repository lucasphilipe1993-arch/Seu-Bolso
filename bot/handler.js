// bot/handler.js — Bot WhatsApp Seu Bolso
const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const db = require('../database/db');

const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ─── Cache de LID → telefone ──────────────────────────────────
const lidCache = new Map();

// ─── Categorias padrão do sistema ─────────────────────────────
const CATEGORIAS_PADRAO = [
  { nome: 'Alimentação',          emoji: '🍔', tipo: 'despesa' },
  { nome: 'Saúde',                emoji: '🏥', tipo: 'despesa' },
  { nome: 'Assinatura',           emoji: '📱', tipo: 'despesa' },
  { nome: 'Transporte',           emoji: '🚗', tipo: 'despesa' },
  { nome: 'Viagem',               emoji: '✈️',  tipo: 'despesa' },
  { nome: 'Doações',              emoji: '🤝', tipo: 'despesa' },
  { nome: 'Impostos',             emoji: '🧾', tipo: 'despesa' },
  { nome: 'Mercado',              emoji: '🛒', tipo: 'despesa' },
  { nome: 'Educação',             emoji: '📚', tipo: 'despesa' },
  { nome: 'Cuidados pessoais',    emoji: '💅', tipo: 'despesa' },
  { nome: 'Lazer e Entretenimento', emoji: '🎉', tipo: 'despesa' },
  { nome: 'Vestuário',            emoji: '👗', tipo: 'despesa' },
  { nome: 'Pets',                 emoji: '🐾', tipo: 'despesa' },
  { nome: 'Casa',                 emoji: '🏠', tipo: 'despesa' },
  { nome: 'Salário',              emoji: '💰', tipo: 'receita' },
  { nome: 'Outros',               emoji: '📦', tipo: 'ambos'   },
];

// ─── Emojis por categoria para exibição ───────────────────────
const EMOJI_CATEGORIA = {
  'Alimentação': '🍔', 'Saúde': '🏥', 'Assinatura': '📱',
  'Transporte': '🚗', 'Viagem': '✈️', 'Doações': '🤝',
  'Impostos': '🧾', 'Mercado': '🛒', 'Educação': '📚',
  'Cuidados pessoais': '💅', 'Lazer e Entretenimento': '🎉',
  'Vestuário': '👗', 'Pets': '🐾', 'Casa': '🏠',
  'Salário': '💰', 'Freelance': '💼', 'Outros': '📦',
};

// ─── Prompt do sistema ────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente financeiro do Seu Bolso.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.

Se for uma transação financeira:
{"tipo":"despesa"|"receita","valor":numero,"descricao":"texto curto","categoria":"Alimentação|Saúde|Assinatura|Transporte|Viagem|Salário|Outros|Doações|Impostos|Mercado|Educação|Cuidados pessoais|Lazer e Entretenimento|Vestuário|Pets|Casa"}

Se NÃO for transação financeira:
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
- Outros: qualquer coisa não listada acima`;

// ─── Gerador de ID curto ──────────────────────────────────────
function gerarIdCurto() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ─── Auth State no PostgreSQL ─────────────────────────────────
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

// ─── Classe principal ─────────────────────────────────────────
class BotGranaZen {
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
    // Estado temporário para fluxo de adição de categoria
    this._estadosCategoriaFluxo = new Map(); // telefone → { etapa }
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
      if (['6','7','8'].includes(numero[0])) {
        digits = ddd + '9' + numero;
        console.log('Numero normalizado (10->11 digitos): ' + telefone + ' -> ' + digits);
      }
    }
    if (digits.length < 10 || digits.length > 11) return digits;
    return digits;
  }

  async _fecharSocket() {
    if (!this.socket) return;
    try {
      this.socket.ev.removeAllListeners();
      if (this.socket.ws?.readyState === 1) {
        this.socket.ws.close(1000);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch {}
    this.socket = null;
  }

  _agendarReconexao() {
    if (this._timerReconexao) { clearTimeout(this._timerReconexao); this._timerReconexao = null; }
    this._tentativas += 1;
    if (this._tentativas > 10) {
      console.error('❌ Máximo de tentativas atingido. Reinicie o serviço.');
      return;
    }
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

  // ─── Garante que as categorias padrão existem no banco ───────
  async _garantirCategoriasPadrao(usuarioId) {
    for (const cat of CATEGORIAS_PADRAO) {
      await db.query(
        `INSERT INTO categorias (usuario_id, nome, tipo)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [usuarioId, cat.nome, cat.tipo]
      ).catch(() => {
        // Fallback sem coluna tipo
        return db.query(
          `INSERT INTO categorias (usuario_id, nome)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [usuarioId, cat.nome]
        );
      });
    }
  }

  // ─── Resolve LID → telefone ───────────────────────────────────
  async _resolverTelefone(remoteJid) {
    if (remoteJid.endsWith('@s.whatsapp.net')) {
      return this._normalizarTelefone(remoteJid.replace('@s.whatsapp.net', ''));
    }
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
    console.warn(`⚠️  Não foi possível resolver LID ${remoteJid}, usando como chave`);
    return remoteJid;
  }

  async iniciar() {
    if (this._reconectando) { console.log('⏳ Reconexão já em andamento.'); return; }
    this._reconectando = true;
    await this._fecharSocket();

    try {
      const { state, saveCreds } = await usePostgresAuthState();
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`🔧 Baileys versão WA: ${version.join('.')}, latest: ${isLatest}`);

      this.socket = makeWASocket({
        version, auth: state, printQRInTerminal: true,
        browser: ['GranaZen', 'Chrome', '120.0.0'],
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
            } catch (err) {
              console.warn(`Erro ao salvar LID do contato:`, err.message);
            }
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
            } catch (err) {
              console.warn(`Erro ao salvar LID do contato:`, err.message);
            }
          }
        }
      });

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          this.qrAtual = qr;
          qrcode.generate(qr, { small: true });
          console.log('📱 Escaneie o QR Code acima para conectar o WhatsApp');
          if (this.onQR) this.onQR(qr);
        }
        if (connection === 'open') {
          this.conectado = true; this.qrAtual = null;
          this._tentativas = 0; this._reconectando = false;
          console.log('✅ WhatsApp Bot conectado!');
          if (this.onConnected) this.onConnected();
        }
        if (connection === 'close') {
          this.conectado = false; this._reconectando = false;
          const codigo = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = codigo === DisconnectReason.loggedOut;
          console.log(`⚠️  Desconectado (${codigo}). Reconectar: ${!loggedOut}`);
          if (this.onDisconnected) this.onDisconnected();
          if (loggedOut) {
            console.warn('🚪 Sessão encerrada. Limpando...');
            try { await db.query(`DELETE FROM whatsapp_session`); } catch {}
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
            await this._roteador(telefone, remoteJid, tipoMsg, msg);
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

  _tipoMensagem(msg) {
    const m = msg.message;
    if (m.conversation || m.extendedTextMessage) return 'texto';
    if (m.audioMessage) return 'audio';
    if (m.imageMessage) return 'imagem';
    if (m.documentMessage) return 'documento';
    return 'outro';
  }

  async _roteador(telefone, remoteJid, tipo, msg) {
    // Verifica se há fluxo de categoria em andamento
    if (this._estadosCategoriaFluxo.has(telefone) && tipo === 'texto') {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      return this._continuarFluxoCategoria(telefone, remoteJid, texto);
    }

    const sessao = await this._buscarSessao(telefone, remoteJid);
    if (!sessao) {
      console.log(`⚠️ Sessão não encontrada para: ${telefone}`);
      return this.enviar(remoteJid,
        `Olá! 👋\n\nEste número não está vinculado a nenhuma conta Seu Bolso.\n\nAcesse o painel em *${process.env.APP_URL}* e cadastre-se para começar!`
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
      await this.registrarTransacao(remoteJid, usuarioId, resultado, '[imagem]');
    } else {
      await this.enviar(remoteJid, `Só consigo processar *texto*, *áudio* e *imagens*.\n\nDigite *ajuda* para ver como usar.`);
    }
  }

  async _buscarSessao(telefone, remoteJid = null) {
    await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});

    let res = await db.query(
      `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
       JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
      [telefone]
    );

    if (res.rows.length === 0 && !telefone.startsWith('55') && !telefone.endsWith('@lid')) {
      res = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
        ['55' + telefone]
      );
      if (res.rows.length > 0) {
        await db.query(`UPDATE sessoes_bot SET telefone = $1 WHERE telefone = $2`, [telefone, '55' + telefone]);
        await db.query(`UPDATE usuarios SET telefone = $1 WHERE telefone = $2`, [telefone, '55' + telefone]);
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
          res = await db.query(
            `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
             JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
            [telDoMap]
          );
        }
      } catch {}
    }

    if (res.rows.length === 0) return null;
    return {
      usuarioId: res.rows[0].usuario_id,
      nome: res.rows[0].nome.split(' ')[0],
      telefone: res.rows[0].telefone,
    };
  }

  // ─── Processamento de texto com todos os comandos ─────────────
  async processarTexto(remoteJid, usuarioId, nome, texto, telefone) {
    const textoLower = texto.toLowerCase().trim();

    // Saudações
    if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start', 'hello'].includes(textoLower))
      return this.enviar(remoteJid, this.msgBemVindo(nome));

    // Resumo / Saldo
// Resumo / Saldo / Relatório
const triggerResumo = [
  'resumo', 'saldo', 'extrato', 'ver resumo', 'resumo financeiro',
  'relatorio', 'relatório', 'gerar relatorio', 'gerar relatório',
  'relatorio de gastos', 'relatório de gastos', 'ver relatorio',
  'ver relatório', 'meus gastos', 'gastos do mes', 'gastos do mês',
  'quanto gastei', 'quanto recebi', 'balanço', 'balanco',
];
if (triggerResumo.includes(textoLower) || textoLower.includes('relat'))
  return this.enviarResumo(remoteJid, usuarioId, nome);

    // Ajuda
    if (['ajuda', 'help', '?', 'menu'].includes(textoLower))
      return this.enviar(remoteJid, this.msgAjuda());

    // Listar categorias
    if (['categorias', 'ver categorias', 'minhas categorias', 'listar categorias'].includes(textoLower))
      return this.enviarCategorias(remoteJid, usuarioId);

    // Adicionar categoria
    if (textoLower.startsWith('nova categoria') || textoLower.startsWith('adicionar categoria') || textoLower === 'add categoria')
      return this.iniciarFluxoNovaCategoria(remoteJid, telefone);

    // Excluir transação: "excluir transação XYZAB" ou "cancelar XYZAB" ou "desfazer XYZAB"
    const matchExcluir = texto.match(/^(?:excluir\s+(?:transa[çc][aã]o\s+)?|cancelar\s+|desfazer\s+|deletar\s+)([A-Z0-9]{4,6})$/i);
    if (matchExcluir) {
      return this.excluirTransacao(remoteJid, usuarioId, matchExcluir[1].toUpperCase());
    }

    // Últimas transações
    if (['últimas', 'ultimas', 'últimos', 'historico', 'histórico', 'últimas transações'].includes(textoLower))
      return this.enviarUltimasTransacoes(remoteJid, usuarioId);

    // Transação normal
    const transacao = await this.interpretarTransacao(texto);
    if (transacao) {
      await this.registrarTransacao(remoteJid, usuarioId, transacao, texto);
    } else {
      await this.enviar(remoteJid,
        `❓ Não entendi essa mensagem como uma transação financeira.\n\n` +
        `Tente algo como:\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n• _Conta de luz 120 reais_\n\n` +
        `Ou envie uma *foto* de nota fiscal/comprovante, ou um *áudio* descrevendo o gasto.\n\n` +
        `Digite *ajuda* para mais opções.`
      );
    }
  }

  // ─── Fluxo para adicionar nova categoria ──────────────────────
  async iniciarFluxoNovaCategoria(remoteJid, telefone) {
    this._estadosCategoriaFluxo.set(telefone, { etapa: 'aguardando_nome' });
    await this.enviar(remoteJid,
      `➕ *Nova Categoria*\n\nQual será o nome da nova categoria?\n\n_Ex: Pets, Jogos, Presente_`
    );
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
      if (nomeCategoria.length < 2 || nomeCategoria.length > 50) {
        return this.enviar(remoteJid, '⚠️ Nome inválido. Use entre 2 e 50 caracteres.');
      }
      estado.nomeCategoria = nomeCategoria;
      estado.etapa = 'aguardando_confirmacao';
      this._estadosCategoriaFluxo.set(telefone, estado);
      await this.enviar(remoteJid,
        `📋 Confirma a criação da categoria *"${nomeCategoria}"*?\n\nResponda *sim* para confirmar ou *não* para cancelar.`
      );
    } else if (estado.etapa === 'aguardando_confirmacao') {
      const resp = texto.toLowerCase().trim();
      if (['sim', 's', 'yes', 'confirmar'].includes(resp)) {
        try {
          await db.query(
            `INSERT INTO categorias (usuario_id, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [sessao.usuarioId, estado.nomeCategoria]
          );
          this._estadosCategoriaFluxo.delete(telefone);
          await this.enviar(remoteJid,
            `✅ Categoria *"${estado.nomeCategoria}"* criada com sucesso!\n\nAgora você pode usá-la ao registrar transações.`
          );
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

  // ─── Lista categorias do usuário ──────────────────────────────
  async enviarCategorias(remoteJid, usuarioId) {
    await this._garantirCategoriasPadrao(usuarioId);
    const { rows } = await db.query(
      `SELECT nome FROM categorias WHERE usuario_id = $1 OR usuario_id IS NULL ORDER BY nome ASC`,
      [usuarioId]
    );
    if (rows.length === 0) {
      return this.enviar(remoteJid, '📂 Você ainda não tem categorias cadastradas.');
    }
    let msg = `📂 *Suas Categorias:*\n\n`;
    for (const row of rows) {
      const emoji = EMOJI_CATEGORIA[row.nome] || '📦';
      msg += `${emoji} ${row.nome}\n`;
    }
    msg += `\n➕ Para criar uma nova categoria, envie:\n_nova categoria_`;
    await this.enviar(remoteJid, msg);
  }

  // ─── Excluir transação por ID curto ──────────────────────────
  async excluirTransacao(remoteJid, usuarioId, idCurto) {
    try {
      const { rows } = await db.query(
        `SELECT id, descricao, valor, tipo, conta_id FROM transacoes
         WHERE usuario_id = $1 AND id_curto = $2`,
        [usuarioId, idCurto]
      );

      if (rows.length === 0) {
        return this.enviar(remoteJid,
          `❌ Transação *${idCurto}* não encontrada.\n\nVerifique o identificador e tente novamente.\n\n_Dica: O identificador aparece quando você registra uma transação._`
        );
      }

      const tx = rows[0];
      const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      // Estorna saldo da conta
      if (tx.conta_id) {
        const sinal = tx.tipo === 'receita' ? -1 : 1;
        await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * tx.valor, tx.conta_id]);
      }

      await db.query(`DELETE FROM transacoes WHERE id = $1`, [tx.id]);

      await this.enviar(remoteJid,
        `🗑️ *Transação excluída com sucesso!*\n\n` +
        `📋 Descrição: ${tx.descricao}\n` +
        `💵 Valor: ${fmt(tx.valor)}\n` +
        `🔖 ID: ${idCurto}\n\n` +
        `✅ O saldo da sua conta foi atualizado.\n\n` +
        `Digite *resumo* para ver seu saldo atual.`
      );
    } catch (err) {
      console.error('Erro ao excluir transação:', err.message);
      await this.enviar(remoteJid, '❌ Erro ao excluir transação. Tente novamente.');
    }
  }

  // ─── Últimas transações ───────────────────────────────────────
  async enviarUltimasTransacoes(remoteJid, usuarioId) {
    const { rows } = await db.query(
      `SELECT t.id_curto, t.descricao, t.valor, t.tipo, c.nome AS categoria, t.data_pagamento
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
       ORDER BY t.created_at DESC LIMIT 5`,
      [usuarioId]
    );

    if (rows.length === 0) {
      return this.enviar(remoteJid, '📭 Nenhuma transação registrada ainda.');
    }

    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    let msg = `🕐 *Últimas 5 transações:*\n\n`;
    for (const tx of rows) {
      const emoji = tx.tipo === 'despesa' ? '💸' : '💰';
      const data = tx.data_pagamento
        ? new Date(tx.data_pagamento).toLocaleDateString('pt-BR')
        : '—';
      msg += `${emoji} *${tx.descricao}* — ${fmt(tx.valor)}\n`;
      msg += `   🏷️ ${tx.categoria || 'Outros'} | 📅 ${data}`;
      if (tx.id_curto) msg += ` | 🔖 ${tx.id_curto}`;
      msg += `\n\n`;
    }
    msg += `_Para excluir, envie: excluir [ID]_\n_Ex: excluir B6EGY_`;
    await this.enviar(remoteJid, msg);
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
      return JSON.parse(conteudo.replace(/```json|```/g, '').trim());
    } catch (err) {
      console.error('Erro ao analisar imagem:', err.response?.data || err.message);
      return null;
    }
  }

  async interpretarTransacao(texto) {
    const padroesGasto = [
      /(?:gastei|paguei|comprei|saiu|debitou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|no?\s+|na\s+|em\s+)?(.*)/i,
      /(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?)?\s*(?:de\s+|no?\s+|na\s+|em\s+)(.+)/i,
    ];
    const padroesReceita = [
      /(?:recebi|ganhei|entrou|creditou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|do?\s+|da\s+)?(.*)/i,
    ];
    for (const p of padroesGasto) {
      const m = texto.match(p);
      if (m && parseFloat(m[1].replace(',', '.')) > 0)
        return { tipo: 'despesa', valor: parseFloat(m[1].replace(',', '.')), descricao: m[2]?.trim() || 'Gasto', categoria: 'Outros' };
    }
    for (const p of padroesReceita) {
      const m = texto.match(p);
      if (m && parseFloat(m[1].replace(',', '.')) > 0)
        return { tipo: 'receita', valor: parseFloat(m[1].replace(',', '.')), descricao: m[2]?.trim() || 'Receita', categoria: 'Outros' };
    }
    if (!process.env.OPENAI_API_KEY) return null;
    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 150, temperature: 0,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: texto }],
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      const conteudo = resp.data.choices[0].message.content.trim();
      if (conteudo === 'null' || !conteudo) return null;
      return JSON.parse(conteudo.replace(/```json|```/g, '').trim());
    } catch (err) {
      console.warn('GPT indisponível:', err.response?.data?.error?.message || err.message);
      return null;
    }
  }

  // ─── Registra transação com ID curto e mensagem rica ─────────
  async registrarTransacao(remoteJid, usuarioId, transacao, textoOriginal) {
    // Garante categorias padrão
    await this._garantirCategoriasPadrao(usuarioId);

    // Garante que a coluna id_curto existe
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});

    let categoriaId = null;
    let categoriaNome = transacao.categoria || 'Outros';
    if (categoriaNome) {
      const catRes = await db.query(
        `SELECT id, nome FROM categorias WHERE (usuario_id = $1 OR usuario_id IS NULL) AND LOWER(nome) = LOWER($2) LIMIT 1`,
        [usuarioId, categoriaNome]
      );
      if (catRes.rows.length > 0) {
        categoriaId = catRes.rows[0].id;
        categoriaNome = catRes.rows[0].nome;
      }
    }

    const contaRes = await db.query('SELECT id, nome FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1', [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;
    const contaNome = contaRes.rows[0]?.nome || 'carteira';

    // Gera ID curto único
    let idCurto;
    let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM transacoes WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
      tentativas++;
    } while (tentativas < 10);

    const dataHoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const { rows } = await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, categoria_id, conta_id, data_vencimento, data_pagamento, pago, origem, mensagem_raw, id_curto)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE,true,'whatsapp',$7,$8) RETURNING id`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor, categoriaId, contaId, textoOriginal, idCurto]
    );

    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * transacao.valor, contaId]);
    }

    if (this.onNovaTransacao) {
      this.onNovaTransacao({
        id: rows[0].id,
        idCurto,
        tipo: transacao.tipo,
        valor: transacao.valor,
        descricao: transacao.descricao,
        categoria: categoriaNome,
        origem: 'whatsapp',
      });
    }

    const emojiTipo = transacao.tipo === 'despesa' ? '🔴' : '🟢';
    const labelTipo = transacao.tipo === 'despesa' ? 'Despesa' : 'Receita';
    const emojiBanner = transacao.tipo === 'despesa' ? '💸' : '💰';
    const emojiCat = EMOJI_CATEGORIA[categoriaNome] || '📦';
    const valorFmt = transacao.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    await this.enviar(remoteJid,
      `${emojiBanner} *Transação registrada com sucesso!*\n\n` +
      `Identificador: *${idCurto}*\n\n` +
      `📋 Resumo da transação:\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✏️ Descrição: ${transacao.descricao}\n` +
      `💵 Valor: ${valorFmt}\n` +
      `🔄 Tipo: ${emojiTipo} ${labelTipo}\n` +
      `${emojiCat} Categoria: ${categoriaNome}\n` +
      `🏦 Conta: ${contaNome}\n` +
      `📅 Data: ${dataHoje}\n` +
      `✅ Pago: ✔️\n\n` +
      `❌ Para excluir diga: "Excluir transação *${idCurto}*".\n\n` +
      `📊 Consulte gráficos e relatórios completos em: *${process.env.APP_URL}/painel*`
    );
  }

  // ─── Resumo financeiro rico ───────────────────────────────────
  async enviarResumo(remoteJid, usuarioId, nome) {
    const agora = new Date();
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const ultimoDia = new Date(ano, mes, 0).getDate();

    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = mesesNome[mes - 1];

    // Totais do mês
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

    // Categorias de despesas
    const { rows: catDespesas } = await db.query(
      `SELECT c.nome, SUM(t.valor) AS total
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
         AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
       GROUP BY c.nome ORDER BY total DESC LIMIT 5`,
      [usuarioId, mes, ano]
    );

    // Categorias de receitas
    const { rows: catReceitas } = await db.query(
      `SELECT c.nome, SUM(t.valor) AS total
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'receita'
         AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
         AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
       GROUP BY c.nome ORDER BY total DESC LIMIT 5`,
      [usuarioId, mes, ano]
    );

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
    msg += `🏛️ *Seu Saldo* até dia ${ultimoDia.toString().padStart(2,'0')}/${mes.toString().padStart(2,'0')}\n\n`;
    msg += `${emojiSaldo} Disponível: *${fmt(saldoDisponivel)}*\n`;
    msg += `📈 Previsto: *${fmt(saldoPrevisto)}* (até ${ultimoDia.toString().padStart(2,'0')}/${mes.toString().padStart(2,'0')})\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📥 *Receitas*\n\n`;
    msg += `✅ Recebido: *${fmt(recebido)}*\n`;
    msg += `⏳ A receber: *${fmt(aReceber)}*\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📤 *Despesas*\n\n`;
    msg += `💳 Pago: *${fmt(pago)}*\n`;
    msg += `⏳ A pagar: *${fmt(aPagar)}*\n\n`;

    if (catDespesas.length > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `📊 *Categorias de Despesas*\n\n`;
      for (const cat of catDespesas) {
        const catNome = cat.nome || 'Outros';
        const emoji = EMOJI_CATEGORIA[catNome] || '📦';
        const pct = totalDespesas > 0 ? ((parseFloat(cat.total) / totalDespesas) * 100).toFixed(1) : '0.0';
        msg += `${emoji} ${catNome} → *${fmt(parseFloat(cat.total))}* (${pct}%)\n`;
      }
      msg += `\n`;
    }

    if (catReceitas.length > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💰 *Categorias de Receitas*\n\n`;
      for (const cat of catReceitas) {
        const catNome = cat.nome || 'Outros';
        const emoji = EMOJI_CATEGORIA[catNome] || '📦';
        msg += `${emoji} ${catNome} → *${fmt(parseFloat(cat.total))}*\n`;
      }
      msg += `\n`;
    } else {
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💰 *Categorias de Receitas*\n`;
      msg += `_Nenhuma receita no período._\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🌐 *Painel completo:*\n${process.env.APP_URL}/painel`;

    await this.enviar(remoteJid, msg);
  }

  async enviar(remoteJid, texto) {
    if (!this.socket || !this.conectado) { console.warn(`Bot desconectado, não enviou para ${remoteJid}`); return; }
    const jid = remoteJid.includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    try {
      await Promise.race([
        this.socket.sendMessage(jid, { text: texto }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
      ]);
    } catch (err) {
      console.warn(`Falha ao enviar para ${jid}: ${err.message}`);
    }
  }

  async enviarBoasVindasECapturarLid(telefone, usuarioId, nome) {
    if (!this.socket || !this.conectado) {
      console.warn('Bot desconectado, não enviou boas-vindas');
      return;
    }

    // Garante categorias padrão para novos usuários
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
        await db.query(
          `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2) ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
          [jidReal, telefone]
        );
        await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});
        await db.query(`UPDATE sessoes_bot SET lid = $1 WHERE usuario_id = $2`, [jidReal, usuarioId]);
        console.log(`✅ LID vinculado ao usuário ${usuarioId}: ${jidReal}`);
      }
    } catch (err) {
      console.warn(`Falha ao enviar boas-vindas para ${jid}:`, err.message);
    }
  }

  async reconectar() {
    this._tentativas = 0; this._reconectando = false;
    if (this._timerReconexao) { clearTimeout(this._timerReconexao); this._timerReconexao = null; }
    await this._fecharSocket();
    await this.iniciar();
  }

  msgBemVindo(nome) {
    return (
      `🎉 Olá, *${nome}*! Seja bem-vindo(a) ao *Seu Bolso*! 👋\n\n` +
      `🤖 Sou seu assistente financeiro pessoal. Posso registrar seus gastos e receitas diretamente aqui no WhatsApp!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 *Como registrar transações:*\n\n` +
      `💬 *Texto:* _Gastei 35 no almoço_\n` +
      `🎤 *Áudio:* Fale o seu gasto\n` +
      `📸 *Foto:* Tire foto da nota fiscal\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Digite *resumo* para ver seu saldo\n` +
      `📂 Digite *categorias* para ver suas categorias\n` +
      `❓ Digite *ajuda* para ver todos os comandos`
    );
  }

  msgAjuda() {
    return (
      `🤖 *Comandos disponíveis:*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 *Registrar transações:*\n` +
      `_Gastei 50 no mercado_\n` +
      `_Paguei 120 de conta de luz_\n` +
      `_Recebi 3000 de salário_\n\n` +
      `🎤 *Áudio:* Mande um áudio falando o gasto\n` +
      `📸 *Foto:* Tire foto de nota fiscal ou comprovante\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *resumo* — Ver saldo e relatório do mês\n` +
      `🕐 *histórico* — Ver últimas 5 transações\n` +
      `📂 *categorias* — Ver suas categorias\n` +
      `➕ *nova categoria* — Adicionar categoria personalizada\n` +
      `🗑️ *excluir [ID]* — Excluir uma transação\n` +
      `   _Ex: excluir B6EGY_\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 Painel web: *${process.env.APP_URL}*`
    );
  }
}

// Helper para evitar erro de referência
function textoLower(t) { return (t || '').toLowerCase().trim(); }

module.exports = BotGranaZen;
