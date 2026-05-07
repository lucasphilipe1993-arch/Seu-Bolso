// bot/handler.js — Bot WhatsApp GranaZen
// IA: OpenAI (GPT-4o-mini para texto/imagem, Whisper para áudio)

const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion, // ✅ CORRIGIDO: importa função de versão
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

// ─── Auth State no PostgreSQL (substitui useMultiFileAuthState) ───────────────
async function usePostgresAuthState() {
  // Garante que a tabela existe
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

  // Carrega ou cria credenciais
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
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
        // logger silencioso
        { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }) }
      ),
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

// ─── Classe principal ─────────────────────────────────────────
class BotGranaZen {
  constructor() {
    this.socket = null;
    this.conectado = false;
    this.qrAtual = null;

    this.onQR = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onNovaTransacao = null;
  }

  // ── Logger silencioso ─────────────────────────────────
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

  // ── Inicia o Baileys ──────────────────────────────────────
  async iniciar() {
    const { state, saveCreds } = await usePostgresAuthState();

    // ✅ CORRIGIDO: busca a versão mais recente do WA Web (evita erro 405)
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔧 Baileys versão WA: ${version.join('.')}, latest: ${isLatest}`);

this.socket = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: true,
  browser: ['GranaZen', 'Chrome', '120.0.0'],
  logger: this._logger,
  syncFullHistory: false,
  connectTimeoutMs: 60000,        // ✅ 60s para conectar (padrão é 20s)
  defaultQueryTimeoutMs: 60000,   // ✅ 60s para queries iniciais
  keepAliveIntervalMs: 25000,     // ✅ mantém conexão viva no Railway
  retryRequestDelayMs: 2000,      // ✅ espera 2s entre retries
  getMessage: async () => ({ conversation: '' }),
});

    this.socket.ev.on('creds.update', saveCreds);

    // ── Conexão ──────────────────────────────────────────
    this.socket.ev.on('connection.update', (update) => {
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
        console.log('✅ WhatsApp Bot conectado!');
        if (this.onConnected) this.onConnected();
      }

      if (connection === 'close') {
        this.conectado = false;
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const deverReconectar = codigo !== DisconnectReason.loggedOut;
        console.log(`⚠️  Desconectado (${codigo}). Reconectar: ${deverReconectar}`);
        if (this.onDisconnected) this.onDisconnected();
        if (deverReconectar) {
          const delay = codigo === 408 ? 15000 : 5000;
          setTimeout(() => this.iniciar(), delay);
        }
      }
    });

    // ── Mensagens recebidas ──────────────────────────────
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const telefone = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
        if (!telefone || msg.key.remoteJid?.endsWith('@g.us')) continue;

        const tipoMsg = this._tipoMensagem(msg);
        console.log(`📩 [${tipoMsg}] de ${telefone}`);

        try {
          await this._roteador(telefone, tipoMsg, msg);
        } catch (err) {
          console.error(`Erro ao processar msg de ${telefone}:`, err.message);
          await this.enviar(telefone, '⚠️ Ocorreu um erro. Tente novamente em instantes.');
        }
      }
    });
  }

  // ── Identifica o tipo da mensagem ────────────────────
  _tipoMensagem(msg) {
    const m = msg.message;
    if (m.conversation || m.extendedTextMessage) return 'texto';
    if (m.audioMessage) return 'audio';
    if (m.imageMessage) return 'imagem';
    if (m.documentMessage) return 'documento';
    return 'outro';
  }

  // ── Roteador principal ───────────────────────────────
  async _roteador(telefone, tipo, msg) {
    const sessao = await this._buscarSessao(telefone);
    if (!sessao) {
      return this.enviar(telefone,
        `Olá! 👋\n\nEste número não está vinculado a nenhuma conta GranaZen.\n\nAcesse o painel em *${process.env.APP_URL}* e vincule seu WhatsApp nas configurações.`
      );
    }

    const { usuarioId, nome } = sessao;

    if (tipo === 'texto') {
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      await this.processarTexto(telefone, usuarioId, nome, texto);

    } else if (tipo === 'audio') {
      await this.enviar(telefone, '🎵 Recebi seu áudio! Transcrevendo...');
      const transcricao = await this._transcreverAudio(msg);
      if (!transcricao) {
        return this.enviar(telefone, '❌ Não consegui entender o áudio. Tente enviar texto.');
      }
      console.log(`🎙️ Transcrição: ${transcricao}`);
      await this.enviar(telefone, `🎙️ _Entendi: "${transcricao}"_`);
      await this.processarTexto(telefone, usuarioId, nome, transcricao);

    } else if (tipo === 'imagem') {
      await this.enviar(telefone, '🖼️ Recebi sua imagem! Analisando...');
      const resultado = await this._analisarImagem(msg);
      if (!resultado) {
        return this.enviar(telefone, '❌ Não consegui extrair informações desta imagem. Tente enviar o valor em texto.');
      }
      await this.registrarTransacao(telefone, usuarioId, resultado, '[imagem]');

    } else {
      await this.enviar(telefone,
        `Só consigo processar *texto*, *áudio* e *imagens* (fotos de nota fiscal/comprovante).\n\nDigite *ajuda* para ver como usar.`
      );
    }
  }

  // ── Busca sessão/usuário pelo telefone ───────────────
  async _buscarSessao(telefone) {
    const res = await db.query(
      `SELECT s.usuario_id, u.nome
       FROM sessoes_bot s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.telefone = $1`,
      [telefone]
    );
    if (res.rows.length === 0) return null;
    return {
      usuarioId: res.rows[0].usuario_id,
      nome: res.rows[0].nome.split(' ')[0],
    };
  }

  // ── Processa mensagem de texto ───────────────────────
  async processarTexto(telefone, usuarioId, nome, texto) {
    const textoLower = texto.toLowerCase().trim();

    if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start', 'hello'].includes(textoLower)) {
      return this.enviar(telefone, this.msgBemVindo(nome));
    }
    if (['resumo', 'saldo', 'extrato'].includes(textoLower)) {
      return this.enviarResumo(telefone, usuarioId, nome);
    }
    if (['ajuda', 'help', '?'].includes(textoLower)) {
      return this.enviar(telefone, this.msgAjuda());
    }

    const transacao = await this.interpretarTransacao(texto);
    if (transacao) {
      await this.registrarTransacao(telefone, usuarioId, transacao, texto);
    } else {
      await this.enviar(telefone,
        `❓ Não entendi essa mensagem como uma transação financeira.\n\nTente algo como:\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n• _Conta de luz 120 reais_\n\nOu envie uma *foto* de nota fiscal/comprovante, ou um *áudio* descrevendo o gasto.\n\nDigite *ajuda* para mais opções.`
      );
    }
  }

  // ── Transcreve áudio com Whisper ─────────────────────
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

  // ── Analisa imagem com GPT-4o Vision ─────────────────
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

  // ── Interpreta texto como transação ──────────────────
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

  // ── Salva transação no banco e responde ──────────────
  async registrarTransacao(telefone, usuarioId, transacao, textoOriginal) {
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

    await this.enviar(telefone,
      `${emoji} *${label} registrada!*\n\n` +
      `📝 ${transacao.descricao}\n` +
      `💵 ${valorFmt}\n` +
      (transacao.categoria ? `🏷️  ${transacao.categoria}\n` : '') +
      `\nDigite *resumo* para ver seu saldo atual.`
    );
  }

  // ── Resumo financeiro do mês ──────────────────────────
  async enviarResumo(telefone, usuarioId, nome) {
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

    await this.enviar(telefone,
      `📊 *Resumo de ${meses[mes - 1]}/${ano}* — ${nome}\n\n` +
      `✅ Receitas:   ${fmt(r)}\n` +
      `❌ Despesas:  ${fmt(d)}\n` +
      `─────────────────\n` +
      `${s >= 0 ? '💚' : '🔴'} *Saldo: ${fmt(s)}*\n\n` +
      `Painel completo:\n${process.env.APP_URL}`
    );
  }

  // ── Envia mensagem via Baileys ────────────────────────
  async enviar(telefone, texto) {
    if (!this.socket || !this.conectado) {
      console.warn(`Bot desconectado, não enviou para ${telefone}`);
      return;
    }
    const jid = `${telefone}@s.whatsapp.net`;
    await this.socket.sendMessage(jid, { text: texto });
  }

  // ── Reconecta ────────────────────────────────────────
  async reconectar() {
    // ✅ CORRIGIDO: usa socket.end() em vez de logout() para não apagar a sessão do PostgreSQL
    if (this.socket) {
      try { this.socket.end(); } catch {}
      this.socket = null;
    }
    await this.iniciar();
  }

  // ── Mensagens padrão ─────────────────────────────────
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
