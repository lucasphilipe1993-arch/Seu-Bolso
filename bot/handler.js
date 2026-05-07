// bot/handler.js — Bot WhatsApp GranaZen
// IA: OpenAI (GPT-4o-mini para texto/imagem, Whisper para áudio)

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

// ─── Prompt do sistema ────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente financeiro do GranaZen.
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
      const res = await db.query(
        'SELECT valor FROM whatsapp_session WHERE chave = $1',
        [key]
      );
      if (res.rows.length === 0) return null;
      return JSON.parse(res.rows[0].valor, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function writeData(key, data) {
    const valor = JSON.stringify(data, BufferJSON.replacer);
    await db.query(
      `INSERT INTO whatsapp_session (chave, valor, atualizado_em)
       VALUES ($1, $2, NOW())
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
              if (val) {
                await writeData(`key-${type}-${id}`, val);
              } else {
                await removeData(`key-${type}-${id}`);
              }
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
    saveCreds: async () => {
      await writeData('creds', state.creds);
    },
  };
}

// ─── Classe principal ─────────────────────────────────────────
class BotGranaZen {
  constructor() {
    this.socket = null;
    this.conectado = false;
    this.qrAtual = null;
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
    const base = {
      level: 'silent',
      trace: silent, debug: silent, info: silent,
      warn: console.warn, error: console.error, fatal: console.error,
    };
    base.child = () => ({ ...base, child: base.child });
    return base;
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
    if (this._timerReconexao) {
      clearTimeout(this._timerReconexao);
      this._timerReconexao = null;
    }

    this._tentativas += 1;

    if (this._tentativas > 10) {
      console.error('❌ Máximo de tentativas de reconexão atingido (10). Reconexão suspensa.');
      return;
    }

    const delay = Math.min(5000 * Math.pow(2, this._tentativas - 1), 60000);
    console.log(`🔁 Tentativa ${this._tentativas}/10 em ${delay / 1000}s...`);

    this._timerReconexao = setTimeout(async () => {
      this._timerReconexao = null;
      await this.iniciar();
    }, delay);
  }

  async iniciar() {
    if (this._reconectando) {
      console.log('⏳ Reconexão já em andamento, ignorando chamada duplicada.');
      return;
    }
    this._reconectando = true;

    await this._fecharSocket();

    try {
      const { state, saveCreds } = await usePostgresAuthState();

      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`🔧 Baileys versão WA: ${version.join('.')}, latest: ${isLatest}`);

      this.socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ['GranaZen', 'Chrome', '120.0.0'],
        logger: this._logger,
        syncFullHistory: false,
        connectTimeoutMs: 90000,
        defaultQueryTimeoutMs: 90000,
        keepAliveIntervalMs: 20000,
        retryRequestDelayMs: 3000,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
        fireInitQueries: false,
      });

      this.socket.ev.on('creds.update', saveCreds);

      // ── Conexão ──────────────────────────────────────────
      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrAtual = qr;
          qrcode.generate(qr, { small: true });
          console.log('📱 Escaneie o QR Code acima para conectar o WhatsApp');
          if (this.onQR) this.onQR(qr);
        }

        if (connection === 'open') {
          this.conectado = true;
          this.qrAtual = null;
          this._tentativas = 0;
          this._reconectando = false;
          console.log('✅ WhatsApp Bot conectado!');
          if (this.onConnected) this.onConnected();
        }

        if (connection === 'close') {
          this.conectado = false;
          this._reconectando = false;

          const codigo = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = codigo === DisconnectReason.loggedOut;

          console.log(`⚠️  Desconectado (${codigo}). Reconectar: ${!loggedOut}`);
          if (this.onDisconnected) this.onDisconnected();

          if (loggedOut) {
            console.warn('🚪 Sessão encerrada pelo WhatsApp. Limpando sessão salva...');
            try { await db.query(`DELETE FROM whatsapp_session`); } catch {}
            this._tentativas = 0;
            this._agendarReconexao();
          } else {
            this._agendarReconexao();
          }
        }
      });

      // ── Mensagens recebidas ──────────────────────────────
      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 upsert recebido: type=${type}, qtd=${messages.length}, jids=${messages.map(m => m.key.remoteJid).join(',')}`);
        if (type !== 'notify') return;

        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (!msg.message) continue;

          const remoteJid = msg.key.remoteJid || '';

          // Ignora grupos e broadcast
          if (remoteJid.endsWith('@g.us')) continue;
          if (remoteJid === 'status@broadcast') continue;

          // FIX: suporte a @lid (novo sistema de IDs do WhatsApp)
          // Usa o remoteJid como chave de busca — funciona tanto com @s.whatsapp.net quanto @lid
          let chaveIdentificacao = '';
          if (remoteJid.endsWith('@s.whatsapp.net')) {
            chaveIdentificacao = remoteJid.replace('@s.whatsapp.net', '');
          } else if (remoteJid.endsWith('@lid')) {
            // Tenta buscar sessão pelo LID completo (ex: "124910634582052@lid")
            chaveIdentificacao = remoteJid;
          } else {
            continue;
          }

          if (!chaveIdentificacao) continue;

          console.log(`📩 mensagem de: ${chaveIdentificacao} | pushName: ${msg.pushName}`);

          const tipoMsg = this._tipoMensagem(msg);

          try {
            await this._roteador(chaveIdentificacao, remoteJid, tipoMsg, msg);
          } catch (err) {
            console.error(`Erro ao processar msg de ${chaveIdentificacao}:`, err.message);
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

  // FIX: agora recebe remoteJid separado para envio correto
  async _roteador(chaveIdentificacao, remoteJid, tipo, msg) {
    const sessao = await this._buscarSessao(chaveIdentificacao);
    if (!sessao) {
      console.log(`⚠️ Sessão não encontrada para: ${chaveIdentificacao}`);
      return this.enviar(remoteJid,
        `Olá! 👋\n\nEste número não está vinculado a nenhuma conta GranaZen.\n\nAcesse o painel em *${process.env.APP_URL}* e vincule seu WhatsApp nas configurações.`
      );
    }

    const { usuarioId, nome } = sessao;

    if (tipo === 'texto') {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      await this.processarTexto(remoteJid, usuarioId, nome, texto);

    } else if (tipo === 'audio') {
      await this.enviar(remoteJid, '🎵 Recebi seu áudio! Transcrevendo...');
      const transcricao = await this._transcreverAudio(msg);
      if (!transcricao) {
        return this.enviar(remoteJid, '❌ Não consegui entender o áudio. Tente enviar texto.');
      }
      console.log(`🎙️ Transcrição: ${transcricao}`);
      await this.enviar(remoteJid, `🎙️ _Entendi: "${transcricao}"_`);
      await this.processarTexto(remoteJid, usuarioId, nome, transcricao);

    } else if (tipo === 'imagem') {
      await this.enviar(remoteJid, '🖼️ Recebi sua imagem! Analisando...');
      const resultado = await this._analisarImagem(msg);
      if (!resultado) {
        return this.enviar(remoteJid, '❌ Não consegui extrair informações desta imagem. Tente enviar o valor em texto.');
      }
      await this.registrarTransacao(remoteJid, usuarioId, resultado, '[imagem]');

    } else {
      await this.enviar(remoteJid,
        `Só consigo processar *texto*, *áudio* e *imagens* (fotos de nota fiscal/comprovante).\n\nDigite *ajuda* para ver como usar.`
      );
    }
  }

  async _buscarSessao(chave) {
    // Busca por telefone numérico ou por LID completo (ex: "124910634582052@lid")
    const res = await db.query(
      `SELECT s.usuario_id, u.nome
       FROM sessoes_bot s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.telefone = $1`,
      [chave]
    );
    if (res.rows.length === 0) return null;
    return {
      usuarioId: res.rows[0].usuario_id,
      nome: res.rows[0].nome.split(' ')[0],
    };
  }

  async processarTexto(remoteJid, usuarioId, nome, texto) {
    const textoLower = texto.toLowerCase().trim();

    if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start', 'hello'].includes(textoLower)) {
      return this.enviar(remoteJid, this.msgBemVindo(nome));
    }
    if (['resumo', 'saldo', 'extrato'].includes(textoLower)) {
      return this.enviarResumo(remoteJid, usuarioId, nome);
    }
    if (['ajuda', 'help', '?'].includes(textoLower)) {
      return this.enviar(remoteJid, this.msgAjuda());
    }

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
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OPENAI_API_KEY não definida');
      return null;
    }

    let tmpFile = null;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      tmpFile = path.join(TMP_DIR, `audio_${Date.now()}.ogg`);
      fs.writeFileSync(tmpFile, buffer);

      const form = new FormData();
      form.append('file', fs.createReadStream(tmpFile), {
        filename: 'audio.ogg',
        contentType: 'audio/ogg',
      });
      form.append('model', 'whisper-1');
      form.append('language', 'pt');
      form.append('response_format', 'text');

      const resp = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          timeout: 30000,
        }
      );

      return typeof resp.data === 'string' ? resp.data.trim() : resp.data?.text?.trim() || null;

    } catch (err) {
      console.error('Erro ao transcrever áudio:', err.response?.data || err.message);
      return null;
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  }

  async _analisarImagem(msg) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OPENAI_API_KEY não definida');
      return null;
    }

    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const base64 = buffer.toString('base64');
      const mimetype = msg.message.imageMessage?.mimetype || 'image/jpeg';

      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          max_tokens: 300,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimetype};base64,${base64}`,
                    detail: 'low',
                  },
                },
                {
                  type: 'text',
                  text: 'Analise esta imagem (nota fiscal, comprovante, recibo ou screenshot de pagamento) e extraia a transação financeira.',
                },
              ],
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const conteudo = resp.data.choices[0].message.content.trim();
      if (conteudo === 'null' || !conteudo) return null;

      const clean = conteudo.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);

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
      if (m && parseFloat(m[1].replace(',', '.')) > 0) {
        return {
          tipo: 'despesa',
          valor: parseFloat(m[1].replace(',', '.')),
          descricao: m[2]?.trim() || 'Gasto',
          categoria: 'Outros',
        };
      }
    }
    for (const p of padroesReceita) {
      const m = texto.match(p);
      if (m && parseFloat(m[1].replace(',', '.')) > 0) {
        return {
          tipo: 'receita',
          valor: parseFloat(m[1].replace(',', '.')),
          descricao: m[2]?.trim() || 'Receita',
          categoria: 'Outros',
        };
      }
    }

    if (!process.env.OPENAI_API_KEY) return null;

    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          max_tokens: 150,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: texto },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const conteudo = resp.data.choices[0].message.content.trim();
      if (conteudo === 'null' || !conteudo) return null;

      const clean = conteudo.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);

    } catch (err) {
      console.warn('GPT indisponível:', err.response?.data?.error?.message || err.message);
      return null;
    }
  }

  async registrarTransacao(remoteJid, usuarioId, transacao, textoOriginal) {
    let categoriaId = null;
    if (transacao.categoria) {
      const catRes = await db.query(
        `SELECT id FROM categorias
         WHERE (usuario_id = $1 OR usuario_id IS NULL)
           AND LOWER(nome) = LOWER($2)
         LIMIT 1`,
        [usuarioId, transacao.categoria]
      );
      if (catRes.rows.length > 0) categoriaId = catRes.rows[0].id;
    }

    const contaRes = await db.query(
      'SELECT id FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1',
      [usuarioId]
    );
    const contaId = contaRes.rows[0]?.id || null;

    const { rows } = await db.query(
      `INSERT INTO transacoes
         (usuario_id, tipo, descricao, valor, categoria_id, conta_id,
          data_vencimento, data_pagamento, pago, origem, mensagem_raw)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,CURRENT_DATE,true,'whatsapp',$7)
       RETURNING id`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor,
       categoriaId, contaId, textoOriginal]
    );

    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query(
        'UPDATE contas SET saldo = saldo + $1 WHERE id = $2',
        [sinal * transacao.valor, contaId]
      );
    }

    if (this.onNovaTransacao) {
      this.onNovaTransacao({
        id: rows[0].id,
        tipo: transacao.tipo,
        valor: transacao.valor,
        descricao: transacao.descricao,
        categoria: transacao.categoria,
        origem: 'whatsapp',
      });
    }

    const emoji = transacao.tipo === 'despesa' ? '💸' : '💰';
    const label = transacao.tipo === 'despesa' ? 'Despesa' : 'Receita';
    const valorFmt = transacao.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    await this.enviar(remoteJid,
      `${emoji} *${label} registrada!*\n\n` +
      `📝 ${transacao.descricao}\n` +
      `💵 ${valorFmt}\n` +
      (transacao.categoria ? `🏷️  ${transacao.categoria}\n` : '') +
      `\nDigite *resumo* para ver seu saldo atual.`
    );
  }

  async enviarResumo(remoteJid, usuarioId, nome) {
    const mes = new Date().getMonth() + 1;
    const ano = new Date().getFullYear();

    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo='receita' AND pago=true THEN valor END), 0) AS receitas,
         COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=true THEN valor END), 0) AS despesas
       FROM transacoes
       WHERE usuario_id = $1
         AND EXTRACT(MONTH FROM data_pagamento) = $2
         AND EXTRACT(YEAR  FROM data_pagamento) = $3`,
      [usuarioId, mes, ano]
    );

    const r = parseFloat(rows[0].receitas);
    const d = parseFloat(rows[0].despesas);
    const s = r - d;
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    await this.enviar(remoteJid,
      `📊 *Resumo de ${meses[mes - 1]}/${ano}* — ${nome}\n\n` +
      `✅ Receitas:   ${fmt(r)}\n` +
      `❌ Despesas:  ${fmt(d)}\n` +
      `─────────────────\n` +
      `${s >= 0 ? '💚' : '🔴'} *Saldo: ${fmt(s)}*\n\n` +
      `Painel completo:\n${process.env.APP_URL}`
    );
  }

  // FIX: enviar aceita tanto @s.whatsapp.net quanto @lid como jid completo
  async enviar(remoteJid, texto) {
    if (!this.socket || !this.conectado) {
      console.warn(`Bot desconectado, não enviou para ${remoteJid}`);
      return;
    }
    // Se já vier com @, usa direto; senão adiciona @s.whatsapp.net
    const jid = remoteJid.includes('@') ? remoteJid : `${remoteJid}@s.whatsapp.net`;
    try {
      await Promise.race([
        this.socket.sendMessage(jid, { text: texto }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('enviar() timeout após 15s')), 15000)
        ),
      ]);
    } catch (err) {
      console.warn(`Falha ao enviar para ${jid}: ${err.message}`);
    }
  }

  async reconectar() {
    this._tentativas = 0;
    this._reconectando = false;
    if (this._timerReconexao) {
      clearTimeout(this._timerReconexao);
      this._timerReconexao = null;
    }
    await this._fecharSocket();
    await this.iniciar();
  }

  msgBemVindo(nome) {
    return (
      `Olá, *${nome}*! 👋\n\n` +
      `Sou o assistente financeiro do GranaZen. Posso registrar seus gastos e receitas diretamente aqui no WhatsApp!\n\n` +
      `*Como usar:*\n` +
      `💬 *Texto:* _Gastei 35 no almoço_\n` +
      `🎤 *Áudio:* Fale o seu gasto\n` +
      `📸 *Foto:* Tire foto da nota fiscal\n\n` +
      `Digite *ajuda* para ver todos os comandos.`
    );
  }

  msgAjuda() {
    return (
      `🤖 *Como registrar transações:*\n\n` +
      `💬 *Por texto:*\n` +
      `_Gastei 50 no mercado_\n` +
      `_Paguei 120 de conta de luz_\n` +
      `_Recebi 3000 de salário_\n\n` +
      `🎤 *Por áudio:*\n` +
      `Mande um áudio falando o gasto normalmente\n\n` +
      `📸 *Por imagem:*\n` +
      `Tire foto de nota fiscal, comprovante ou recibo\n\n` +
      `📊 *resumo* — Ver saldo do mês\n` +
      `❓ *ajuda* — Esta mensagem\n\n` +
      `Painel web: *${process.env.APP_URL}*`
    );
  }
}

module.exports = BotGranaZen;
