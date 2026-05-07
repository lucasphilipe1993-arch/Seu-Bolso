// bot/handler.js — Lógica principal do bot WhatsApp
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const db = require('../database/db');
const axios = require('axios');

const SESSAO_DIR = path.join(process.cwd(), 'sessao_whatsapp');

// Logger seguro que nunca é undefined em nenhum nível
function makeLogger() {
  const noop = () => {};
  const logger = {
    level: 'silent',
    trace: noop, debug: noop, info: noop,
    warn: console.warn, error: console.error, fatal: console.error,
  };
  logger.child = () => ({ ...logger, child: () => ({ ...logger }) });
  return logger;
}

class BotGranaZen {
  constructor() {
    this.socket = null;
    this.conectado = false;
    this.qrAtual = null;
  }

  async iniciar() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);

      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['GranaZen Bot', 'Chrome', '1.0'],
        logger: makeLogger(),
      });

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('connection.update', (update) => {
        try {
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            this.qrAtual = qr;
            qrcode.generate(qr, { small: true });
            console.log('📱 Escaneie o QR Code acima para conectar o WhatsApp');
          }

          if (connection === 'open') {
            this.conectado = true;
            this.qrAtual = null;
            console.log('✅ WhatsApp Bot conectado!');
          }

          if (connection === 'close') {
            this.conectado = false;
            const codigo = lastDisconnect?.error?.output?.statusCode;
            const deverReconectar = codigo !== DisconnectReason.loggedOut;
            console.log(`⚠️  Desconectado. Código: ${codigo}. Reconectar: ${deverReconectar}`);
            if (deverReconectar) {
              setTimeout(() => this.iniciar(), 5000);
            }
          }
        } catch (err) {
          console.error('Erro no evento connection.update:', err.message);
        }
      });

      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          try {
            if (msg.key.fromMe) continue;
            if (!msg.message) continue;

            const telefone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const texto = msg.message.conversation
              || msg.message.extendedTextMessage?.text
              || '';

            if (!texto) continue;
            console.log(`📩 Mensagem de ${telefone}: ${texto}`);
            await this.processarMensagem(telefone, texto, msg);
          } catch (err) {
            console.error('Erro ao processar mensagem:', err.message);
          }
        }
      });

    } catch (err) {
      console.error('⚠️  Erro ao iniciar bot:', err.message);
      setTimeout(() => this.iniciar(), 10000);
    }
  }

  async processarMensagem(telefone, texto, msgOriginal) {
    try {
      const sessaoRes = await db.query(
        'SELECT s.*, u.nome FROM sessoes_bot s JOIN usuarios u ON u.id = s.usuario_id WHERE s.telefone = $1',
        [telefone]
      );

      if (sessaoRes.rows.length === 0) {
        await this.enviar(telefone, `Olá! 👋\n\nEste número não está vinculado a nenhuma conta.\n\nAcesse o painel em *${process.env.APP_URL}* e vincule seu WhatsApp nas configurações.`);
        return;
      }

      const sessao = sessaoRes.rows[0];
      const usuarioId = sessao.usuario_id;
      const nome = sessao.nome.split(' ')[0];
      const textoLower = texto.toLowerCase().trim();

      if (['oi', 'olá', 'ola', 'oi!', 'olá!', 'start'].includes(textoLower)) {
        return this.enviar(telefone, this.msgBemVindo(nome));
      }
      if (textoLower === 'resumo' || textoLower === 'saldo') {
        return this.enviarResumo(telefone, usuarioId, nome);
      }
      if (textoLower === 'ajuda' || textoLower === 'help') {
        return this.enviar(telefone, this.msgAjuda());
      }

      const transacao = await this.interpretarTransacao(texto);
      if (transacao) {
        await this.registrarTransacao(telefone, usuarioId, transacao, texto);
      } else {
        await this.enviar(telefone,
          `❓ Não entendi. Tente algo como:\n\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n\nOu digite *ajuda* para ver todos os comandos.`
        );
      }
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
      await this.enviar(telefone, '⚠️ Ocorreu um erro. Tente novamente em instantes.');
    }
  }

  async interpretarTransacao(texto) {
    const padroesGasto = [
      /(?:gastei|paguei|comprei|saiu|debitou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|no?\s+|na\s+|em\s+)?(.*)/i,
      /(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?)?\s*(?:de\s+|no?\s+|na\s+|em\s+)(.*)/i,
    ];
    const padroesReceita = [
      /(?:recebi|ganhei|entrou|creditou?)\s+(?:R\$\s*)?(\d+[,.]?\d*)\s*(?:reais?|r\$)?\s*(?:de\s+|do?\s+|da\s+)?(.*)/i,
    ];

    for (const p of padroesGasto) {
      const m = texto.match(p);
      if (m) return { tipo: 'despesa', valor: parseFloat(m[1].replace(',', '.')), descricao: m[2]?.trim() || 'Gasto' };
    }
    for (const p of padroesReceita) {
      const m = texto.match(p);
      if (m) return { tipo: 'receita', valor: parseFloat(m[1].replace(',', '.')), descricao: m[2]?.trim() || 'Receita' };
    }

    if (process.env.OPENAI_API_KEY) {
      try {
        const resp = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `Analise a mensagem e retorne JSON com: {"tipo":"despesa"|"receita","valor":numero,"descricao":"texto curto","categoria":"Alimentação|Transporte|Moradia|Saúde|Lazer|Educação|Roupas|Salário|Freelance|Outros"}. Se não for transação financeira, retorne null.` },
              { role: 'user', content: texto }
            ],
            temperature: 0,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        const conteudo = resp.data.choices[0].message.content.trim();
        if (conteudo === 'null') return null;
        return JSON.parse(conteudo);
      } catch (err) {
        console.warn('IA indisponível:', err.message);
      }
    }
    return null;
  }

  async registrarTransacao(telefone, usuarioId, transacao, textoOriginal) {
    let categoriaId = null;
    if (transacao.categoria) {
      const catRes = await db.query(
        `SELECT id FROM categorias WHERE (usuario_id = $1 OR usuario_id IS NULL) AND LOWER(nome) = LOWER($2) LIMIT 1`,
        [usuarioId, transacao.categoria]
      );
      if (catRes.rows.length > 0) categoriaId = catRes.rows[0].id;
    }

    const contaRes = await db.query(
      'SELECT id FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1',
      [usuarioId]
    );
    const contaId = contaRes.rows[0]?.id || null;

    await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, categoria_id, conta_id, data_vencimento, pago, origem, mensagem_raw)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,true,'whatsapp',$7)`,
      [usuarioId, transacao.tipo, transacao.descricao, transacao.valor, categoriaId, contaId, textoOriginal]
    );

    if (contaId) {
      const sinal = transacao.tipo === 'receita' ? 1 : -1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * transacao.valor, contaId]);
    }

    const emoji = transacao.tipo === 'despesa' ? '💸' : '💰';
    const valorFmt = transacao.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    await this.enviar(telefone,
      `${emoji} *${transacao.tipo === 'despesa' ? 'Despesa' : 'Receita'} registrada!*\n\n` +
      `📝 ${transacao.descricao}\n💵 ${valorFmt}\n` +
      (transacao.categoria ? `🏷️  ${transacao.categoria}\n` : '') +
      `\nDigite *resumo* para ver seu saldo atual.`
    );
  }

  async enviarResumo(telefone, usuarioId, nome) {
    const mes = new Date().getMonth() + 1;
    const ano = new Date().getFullYear();

    const { rows } = await db.query(
      `SELECT
         SUM(CASE WHEN tipo='receita' AND pago=true THEN valor ELSE 0 END) AS receitas,
         SUM(CASE WHEN tipo='despesa' AND pago=true THEN valor ELSE 0 END) AS despesas
       FROM transacoes
       WHERE usuario_id=$1
         AND EXTRACT(MONTH FROM data_vencimento)=$2
         AND EXTRACT(YEAR FROM data_vencimento)=$3`,
      [usuarioId, mes, ano]
    );

    const r = parseFloat(rows[0].receitas || 0);
    const d = parseFloat(rows[0].despesas || 0);
    const s = r - d;
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    await this.enviar(telefone,
      `📊 *Resumo de ${meses[mes-1]}/${ano}* — ${nome}\n\n` +
      `✅ Receitas:  ${fmt(r)}\n❌ Despesas: ${fmt(d)}\n─────────────────\n` +
      `${s >= 0 ? '💚' : '🔴'} *Saldo: ${fmt(s)}*\n\nAcesse o painel: ${process.env.APP_URL}`
    );
  }

  async enviar(telefone, texto) {
    if (!this.socket || !this.conectado) return;
    try {
      const jid = `${telefone}@s.whatsapp.net`;
      await this.socket.sendMessage(jid, { text: texto });
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err.message);
    }
  }

  async reconectar() {
    if (this.socket) {
      try { await this.socket.logout(); } catch (_) {}
    }
    await this.iniciar();
  }

  msgBemVindo(nome) {
    return `Olá, *${nome}*! 👋\n\nSou seu assistente financeiro. Exemplos:\n• _Gastei 35 no almoço_\n• _Recebi 2500 de salário_\n\nDigite *ajuda* para mais opções.`;
  }

  msgAjuda() {
    return `🤖 *Comandos disponíveis:*\n\n` +
      `📝 *Registrar gasto:*\n_Gastei 50 no mercado_\n\n` +
      `💰 *Registrar receita:*\n_Recebi 3000 de salário_\n\n` +
      `📊 *resumo* — Ver saldo do mês\n❓ *ajuda* — Esta mensagem\n\nPainel: *${process.env.APP_URL}*`;
  }
}

module.exports = BotGranaZen;
