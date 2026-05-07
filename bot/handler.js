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

// ─── Prompt do sistema ────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente financeiro do Seu Bolso.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.

Se for uma transação financeira:
{"tipo":"despesa"|"receita","valor":numero,"descricao":"texto curto","categoria":"Alimentação|Transporte|Moradia|Saúde|Lazer|Educação|Roupas|Salário|Freelance|Outros"}

Se NÃO for transação financeira:
null

Categorias:
- Alimentação: mercado, restaurante, lanche, ifood, delivery, comida
- Transporte: uber, gasolina, ônibus, metrô, 99, passagem, táxi
- Moradia: aluguel, condomínio, água, luz, energia, internet, gás
- Saúde: farmácia, médico, consulta, remédio, academia, plano de saúde
- Lazer: cinema, streaming, netflix, spotify, show, viagem, bar
- Educação: curso, livro, mensalidade, escola, faculdade
- Roupas: roupa, sapato, tênis, calçado, vestuário
- Salário: salário, holerite, pagamento recebido
- Freelance: freela, freelance, bico, serviço prestado
- Outros: qualquer coisa não listada`;

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
    this.lidCache = lidCache; // expõe para o auth.js usar
    this._tentativas = 0;
    this._reconectando = false;
    this._timerReconexao = null;
    this.onQR = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onNovaTransacao = null;
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

  // ─── Resolve LID → telefone ───────────────────────────────────
  // Ordem: @s.whatsapp.net direto → cache → banco lid_map → onWhatsApp() com retry
  async _resolverTelefone(remoteJid) {
    if (remoteJid.endsWith('@s.whatsapp.net')) {
      return this._normalizarTelefone(remoteJid.replace('@s.whatsapp.net', ''));
    }

    // Cache em memória
    if (lidCache.has(remoteJid)) return lidCache.get(remoteJid);

    // Banco lid_map
    try {
      await this._garantirTabelaLidMap();
      const res = await db.query('SELECT telefone FROM lid_map WHERE lid = $1', [remoteJid]);
      if (res.rows.length > 0) {
        const telefone = this._normalizarTelefone(res.rows[0].telefone);
        lidCache.set(remoteJid, telefone);
        return telefone;
      }
    } catch {}

    // onWhatsApp() com retry
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
            console.log(`🔗 LID resolvido via onWhatsApp (tentativa ${tentativa}): ${remoteJid} → ${telefone}`);
            return telefone;
          }
        } catch (err) {
          console.warn(`onWhatsApp tentativa ${tentativa}/3 falhou para ${remoteJid}:`, err.message);
        }
        if (tentativa < 3) await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Fallback: retorna o LID mesmo (será tratado no _buscarSessao)
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

      // ── Popula lid_map ao receber lista de contatos ───────────
      this.socket.ev.on('contacts.upsert', async (contacts) => {
        console.log('📋 contacts.upsert recebido:', JSON.stringify(contacts.slice(0, 5), null, 2));
        for (const contact of contacts) {
          // Loga cada contato que tiver LID
          if (contact.lid) {
            console.log(`📋 Contato com LID: lid=${contact.lid} id=${contact.id}`);
          }
          if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
            const telefone = this._normalizarTelefone(
              contact.id.replace('@s.whatsapp.net', '')
            );
            try {
              await this._garantirTabelaLidMap();
              await db.query(
                `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2)
                 ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
                [contact.lid, telefone]
              );
              lidCache.set(contact.lid, telefone);
              console.log(`✅ LID mapeado via contacts.upsert: ${contact.lid} → ${telefone}`);
            } catch (err) {
              console.warn(`Erro ao salvar LID do contato:`, err.message);
            }
          }
        }
      });

      this.socket.ev.on('contacts.update', async (contacts) => {
        console.log('📋 contacts.update recebido:', JSON.stringify(contacts.slice(0, 5), null, 2));
        for (const contact of contacts) {
          if (contact.lid) {
            console.log(`📋 Update contato com LID: lid=${contact.lid} id=${contact.id}`);
          }
          if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
            const telefone = this._normalizarTelefone(
              contact.id.replace('@s.whatsapp.net', '')
            );
            try {
              await this._garantirTabelaLidMap();
              await db.query(
                `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2)
                 ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
                [contact.lid, telefone]
              );
              lidCache.set(contact.lid, telefone);
              console.log(`✅ LID mapeado via contacts.update: ${contact.lid} → ${telefone}`);
            } catch (err) {
              console.warn(`Erro ao salvar LID do contato:`, err.message);
            }
          }
        }
      });

      // ── Conexão ───────────────────────────────────────────────
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

      // ── Mensagens recebidas ───────────────────────────────────
      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 upsert: type=${type}, qtd=${messages.length}, jids=${messages.map(m => m.key.remoteJid).join(',')}`);
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
    const sessao = await this._buscarSessao(telefone, remoteJid);
    if (!sessao) {
      console.log(`⚠️ Sessão não encontrada para: ${telefone}`);
      return this.enviar(remoteJid,
        `Olá! 👋\n\nEste número não está vinculado a nenhuma conta Seu Bolso.\n\nAcesse o painel em *${process.env.APP_URL}* e cadastre-se para começar!`
      );
    }

    // Se resolveu pelo LID, persiste o mapeamento para próximas mensagens
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
      await this.processarTexto(remoteJid, usuarioId, nome, texto);
    } else if (tipo === 'audio') {
      await this.enviar(remoteJid, '🎵 Recebi seu áudio! Transcrevendo...');
      const transcricao = await this._transcreverAudio(msg);
      if (!transcricao) return this.enviar(remoteJid, '❌ Não consegui entender o áudio. Tente enviar texto.');
      console.log(`🎙️ Transcrição: ${transcricao}`);
      await this.enviar(remoteJid, `🎙️ _Entendi: "${transcricao}"_`);
      await this.processarTexto(remoteJid, usuarioId, nome, transcricao);
    } else if (tipo === 'imagem') {
      await this.enviar(remoteJid, '🖼️ Recebi sua imagem! Analisando...');
      const resultado = await this._analisarImagem(msg);
      if (!resultado) return this.enviar(remoteJid, '❌ Não consegui extrair informações desta imagem. Tente enviar o valor em texto.');
      await this.registrarTransacao(remoteJid, usuarioId, resultado, '[imagem]');
    } else {
      await this.enviar(remoteJid, `Só consigo processar *texto*, *áudio* e *imagens*.\n\nDigite *ajuda* para ver como usar.`);
    }
  }

  // ─── Busca sessão por telefone OU por LID ─────────────────────
  async _buscarSessao(telefone, remoteJid = null) {
    // Garante coluna lid existe
    await db.query(`ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`).catch(() => {});

    // 1. Busca pelo telefone normalizado
    let res = await db.query(
      `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
       JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
      [telefone]
    );

    // 2. Fallback: DDI 55 (sessões antigas)
    if (res.rows.length === 0 && !telefone.startsWith('55') && !telefone.endsWith('@lid')) {
      res = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1`,
        ['55' + telefone]
      );
      if (res.rows.length > 0) {
        console.log(`🔧 Corrigindo telefone no banco: 55${telefone} → ${telefone}`);
        await db.query(`UPDATE sessoes_bot SET telefone = $1 WHERE telefone = $2`, [telefone, '55' + telefone]);
        await db.query(`UPDATE usuarios SET telefone = $1 WHERE telefone = $2`, [telefone, '55' + telefone]);
      }
    }

    // 3. Fallback: busca pelo LID na coluna lid da sessoes_bot
    // (para clientes que cadastraram e já tinham o LID salvo)
    if (res.rows.length === 0 && remoteJid?.endsWith('@lid')) {
      res = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.lid = $1`,
        [remoteJid]
      );
      if (res.rows.length > 0) {
        console.log(`🔗 Sessão encontrada pelo LID ${remoteJid} → ${res.rows[0].telefone}`);
      }
    }

    // 4. Fallback: busca pelo LID no lid_map e depois na sessoes_bot
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
          if (res.rows.length > 0) {
            console.log(`🔗 Sessão encontrada via lid_map: ${remoteJid} → ${telDoMap}`);
          }
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

  async processarTexto(remoteJid, usuarioId, nome, texto) {
    const textoLower = texto.toLowerCase().trim();
    if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start', 'hello'].includes(textoLower))
      return this.enviar(remoteJid, this.msgBemVindo(nome));
    if (['resumo', 'saldo', 'extrato'].includes(textoLower))
      return this.enviarResumo(remoteJid, usuarioId, nome);
    if (['ajuda', 'help', '?'].includes(textoLower))
      return this.enviar(remoteJid, this.msgAjuda());

    const transacao = await this.interpretarTransacao(texto);
    if (transacao) {
      await this.registrarTransacao(remoteJid, usuarioId, transacao, texto);
    } else {
      await this.enviar(remoteJid,
        `❓ Não entendi essa mensagem como uma transação financeira.\n\nTente algo como:\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n• _Conta de luz 120 reais_\n\nOu envie uma *foto* de nota fiscal/comprovante, ou um *áudio* descrevendo o gasto.\n\nDigite *ajuda* para mais opções.`
      );
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

  async registrarTransacao(remoteJid, usuarioId, transacao, textoOriginal) {
    let categoriaId = null;
    if (transacao.categoria) {
      const catRes = await db.query(
        `SELECT id FROM categorias WHERE (usuario_id = $1 OR usuario_id IS NULL) AND LOWER(nome) = LOWER($2) LIMIT 1`,
        [usuarioId, transacao.categoria]
      );
      if (catRes.rows.length > 0) categoriaId = catRes.rows[0].id;
    }
    const contaRes = await db.query('SELECT id FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1', [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;
    const { rows } = await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, categoria_id, conta_id, data_vencimento, data_pagamento, pago, origem, mensagem_raw)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE,true,'whatsapp',$7) RETURNING id`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor, categoriaId, contaId, textoOriginal]
    );
    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * transacao.valor, contaId]);
    }
    if (this.onNovaTransacao) {
      this.onNovaTransacao({ id: rows[0].id, tipo: transacao.tipo, valor: transacao.valor, descricao: transacao.descricao, categoria: transacao.categoria, origem: 'whatsapp' });
    }
    const emoji = transacao.tipo === 'despesa' ? '💸' : '💰';
    const label = transacao.tipo === 'despesa' ? 'Despesa' : 'Receita';
    const valorFmt = transacao.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    await this.enviar(remoteJid,
      `${emoji} *${label} registrada!*\n\n📝 ${transacao.descricao}\n💵 ${valorFmt}\n` +
      (transacao.categoria ? `🏷️  ${transacao.categoria}\n` : '') +
      `\nDigite *resumo* para ver seu saldo atual.`
    );
  }

  async enviarResumo(remoteJid, usuarioId, nome) {
    const mes = new Date().getMonth() + 1;
    const ano = new Date().getFullYear();
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN tipo='receita' AND pago=true THEN valor END), 0) AS receitas,
              COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=true THEN valor END), 0) AS despesas
       FROM transacoes WHERE usuario_id = $1
         AND EXTRACT(MONTH FROM data_pagamento) = $2 AND EXTRACT(YEAR FROM data_pagamento) = $3`,
      [usuarioId, mes, ano]
    );
    const r = parseFloat(rows[0].receitas);
    const d = parseFloat(rows[0].despesas);
    const s = r - d;
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    await this.enviar(remoteJid,
      `📊 *Resumo de ${meses[mes - 1]}/${ano}* — ${nome}\n\n` +
      `✅ Receitas:   ${fmt(r)}\n❌ Despesas:  ${fmt(d)}\n─────────────────\n` +
      `${s >= 0 ? '💚' : '🔴'} *Saldo: ${fmt(s)}*\n\nPainel completo:\n${process.env.APP_URL}`
    );
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

  // ─── Envia boas-vindas e captura o LID real na resposta ──────
  // Chamado no cadastro para mapear telefone → LID antes da 1ª mensagem
  async enviarBoasVindasECapturarLid(telefone, usuarioId, nome) {
    if (!this.socket || !this.conectado) {
      console.warn('Bot desconectado, não enviou boas-vindas');
      return;
    }

    const jid = `55${telefone}@s.whatsapp.net`;

    try {
      const resultado = await Promise.race([
        this.socket.sendMessage(jid, { text: this.msgBemVindo(nome) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
      ]);

      console.log('📤 Resposta sendMessage boas-vindas:', JSON.stringify(resultado?.key || resultado, null, 2));

      // O Baileys retorna o JID real (pode ser LID) na chave da mensagem enviada
      const jidReal = resultado?.key?.remoteJid || resultado?.key?.participant || null;

      if (jidReal && jidReal.endsWith('@lid')) {
        console.log(`🔗 LID capturado no envio: ${jidReal} → ${telefone}`);
        lidCache.set(jidReal, telefone);
        await this._garantirTabelaLidMap();
        await db.query(
          `INSERT INTO lid_map (lid, telefone) VALUES ($1, $2)
           ON CONFLICT (lid) DO UPDATE SET telefone = $2`,
          [jidReal, telefone]
        );
        await db.query(
          `ALTER TABLE sessoes_bot ADD COLUMN IF NOT EXISTS lid TEXT`
        ).catch(() => {});
        await db.query(
          `UPDATE sessoes_bot SET lid = $1 WHERE usuario_id = $2`,
          [jidReal, usuarioId]
        );
        console.log(`✅ LID vinculado ao usuário ${usuarioId}: ${jidReal}`);
      } else {
        console.log(`ℹ️  JID retornado no envio: ${jidReal} (não é LID, número usa @s.whatsapp.net normal)`);
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
      `Olá, *${nome}*! 👋\n\n` +
      `Sou o assistente financeiro do Seu Bolso. Posso registrar seus gastos e receitas diretamente aqui no WhatsApp!\n\n` +
      `*Como usar:*\n💬 *Texto:* _Gastei 35 no almoço_\n🎤 *Áudio:* Fale o seu gasto\n📸 *Foto:* Tire foto da nota fiscal\n\n` +
      `Digite *ajuda* para ver todos os comandos.`
    );
  }

  msgAjuda() {
    return (
      `🤖 *Como registrar transações:*\n\n` +
      `💬 *Por texto:*\n_Gastei 50 no mercado_\n_Paguei 120 de conta de luz_\n_Recebi 3000 de salário_\n\n` +
      `🎤 *Por áudio:*\nMande um áudio falando o gasto normalmente\n\n` +
      `📸 *Por imagem:*\nTire foto de nota fiscal, comprovante ou recibo\n\n` +
      `📊 *resumo* — Ver saldo do mês\n❓ *ajuda* — Esta mensagem\n\nPainel web: *${process.env.APP_URL}*`
    );
  }
}

module.exports = BotGranaZen;
