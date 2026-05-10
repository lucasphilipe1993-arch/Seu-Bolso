// bot/handler-oficial.js
// ─────────────────────────────────────────────────────────────────────────────
// Cérebro do Bot WhatsApp API Oficial (Meta)
// Roda em PARALELO com o bot Baileys (bot/handler.js) sem conflito algum.
// Toda a lógica de negócio (interpretarTransacao, registrarTransacao, etc.)
// é importada do handler Baileys — sem duplicação de código.
// ─────────────────────────────────────────────────────────────────────────────

const axios  = require('axios');
const db     = require('../database/db');
const { LimitesAlertas } = require('./limites_alertas');

// ── Constantes de ambiente ────────────────────────────────────────────────────
const ACCESS_TOKEN    = process.env.WA_OFICIAL_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_OFICIAL_PHONE_ID;
const GRAPH_URL       = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// ── Helpers de formatação (espelhados do handler Baileys) ─────────────────────
const EMOJI_CATEGORIA = {
  'Alimentação': '🍔', 'Saúde': '🏥', 'Assinatura': '📱',
  'Transporte': '🚗', 'Viagem': '✈️', 'Doações': '🤝',
  'Impostos': '🧾', 'Mercado': '🛒', 'Educação': '📚',
  'Cuidados pessoais': '💅', 'Lazer e Entretenimento': '🎉',
  'Vestuário': '👗', 'Pets': '🐾', 'Casa': '🏠',
  'Salário': '💰', 'Freelance': '💼', 'Outros': '📦',
};

const CATEGORIAS_PADRAO = [
  { nome: 'Alimentação', tipo: 'despesa' }, { nome: 'Saúde', tipo: 'despesa' },
  { nome: 'Assinatura', tipo: 'despesa' }, { nome: 'Transporte', tipo: 'despesa' },
  { nome: 'Viagem', tipo: 'despesa' }, { nome: 'Doações', tipo: 'despesa' },
  { nome: 'Impostos', tipo: 'despesa' }, { nome: 'Mercado', tipo: 'despesa' },
  { nome: 'Educação', tipo: 'despesa' }, { nome: 'Cuidados pessoais', tipo: 'despesa' },
  { nome: 'Lazer e Entretenimento', tipo: 'despesa' }, { nome: 'Vestuário', tipo: 'despesa' },
  { nome: 'Pets', tipo: 'despesa' }, { nome: 'Casa', tipo: 'despesa' },
  { nome: 'Salário', tipo: 'receita' }, { nome: 'Outros', tipo: 'ambos' },
];

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function gerarIdCurto() {
  let id = '';
  for (let i = 0; i < 3; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return id;
}

const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ── System prompts (idênticos ao handler Baileys) ─────────────────────────────
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
- Outros: qualquer coisa não listada acima`;

const SYSTEM_PROMPT_DIVIDA = `Você é o assistente financeiro do Seu Secretário.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.
Hoje é: {DATA_HOJE}.

Se a mensagem indica que OUTRA PESSOA deve dinheiro ao usuário:
{"tipo":"divida_receber","devedor":"nome","valor":numero,"descricao":"texto curto","data_vencimento":"YYYY-MM-DD ou null"}

Se NÃO for sobre receber dinheiro de terceiros: null

Exemplos:
- "Bruno me deve 40 reais" → devedor: Bruno
- "Emprestei 200 pra Ana, ela paga dia 15/10" → devedor: Ana, data_vencimento: {ANO_ATUAL}-10-15`;

const SYSTEM_PROMPT_AGENDA = `Você é o assistente de agenda do Seu Secretário.
Analise a mensagem e retorne APENAS JSON, sem markdown, sem explicação.
Hoje é: {DATA_HOJE}. Hora atual (BRT): {HORA_ATUAL}.

Se a mensagem descreve um compromisso, evento, reunião, consulta, tarefa agendada ou lembrete futuro:
{"tipo":"compromisso","titulo":"texto curto","data_hora":"YYYY-MM-DD HH:MM","lembrar_antes":30,"local":"local ou null","notas":"observações ou null"}

Se NÃO for compromisso/agenda: null`;

// ─────────────────────────────────────────────────────────────────────────────
// Classe BotOficial
// ─────────────────────────────────────────────────────────────────────────────
class BotOficial {
  constructor() {
    // Mapa de estados por telefone (fluxos multi-etapa como nova categoria)
    this._estados = new Map();
    // Instância de alertas de limites (reusa a mesma lógica do Baileys)
    this._limitesAlertas = new LimitesAlertas(this);
    // Timer de lembretes de agenda (independente do Baileys)
    this._timerLembretes = null;
  }

  // ── Ponto de entrada: chamado pelo webhook (routes/whatsapp-oficial.js) ─────
  async processarWebhook(body) {
    try {
      const entry   = body?.entry?.[0];
      const changes = entry?.changes?.[0]?.value;
      const message = changes?.messages?.[0];
      const contact = changes?.contacts?.[0];

      if (!message) return; // status de entrega, leitura, etc — ignorar

      const from     = message.from;          // ex: 5511999999999
      const type     = message.type;
      const pushName = contact?.profile?.name || null;

      // ── Clique em botão ou seleção de lista ───────────────────────────────
      if (type === 'interactive') {
        const iType = message.interactive?.type;
        let buttonId = null;

        if (iType === 'button_reply') {
          buttonId = message.interactive.button_reply?.id;
        } else if (iType === 'list_reply') {
          buttonId = message.interactive.list_reply?.id;
        }

        if (buttonId) {
          const sessao = await this._buscarSessao(from);
          if (!sessao) return this._responderNaoCadastrado(from);
          return this._processarCliqueBotao(from, sessao.usuarioId, sessao.nome, buttonId);
        }
        return; // tipo interativo desconhecido — ignorar
      }

      let texto = '';

      if (type === 'text') {
        texto = message.text?.body || '';
      } else if (type === 'audio') {
        // Transcrição via Whisper (mesmo fluxo do Baileys)
        await this.enviar(from, '🎵 Recebi seu áudio! Transcrevendo...');
        const mediaId = message.audio?.id;
        texto = await this._transcreverAudioMeta(mediaId);
        if (!texto) return this.enviar(from, '❌ Não consegui entender o áudio. Tente enviar texto.');
        await this.enviar(from, `🎙️ _Entendi: "${texto}"_`);
      } else if (type === 'image') {
        await this.enviar(from, '🖼️ Recebi sua imagem! Analisando...');
        const mediaId = message.image?.id;
        const resultado = await this._analisarImagemMeta(mediaId);
        if (!resultado) return this.enviar(from, '❌ Não consegui extrair informações desta imagem. Tente enviar o valor em texto.');
        const sessao = await this._buscarSessao(from);
        if (!sessao) return this._responderNaoCadastrado(from);
        return this.registrarTransacao(from, sessao.usuarioId, resultado, '[imagem]', from);
      } else {
        // Tipo não suportado (sticker, vídeo, etc) — ignora silenciosamente
        console.log(`[META] Tipo de mensagem ignorado: ${type} de ${from}`);
        return;
      }

      if (!texto) return;

      console.log(`📲 [META] ${from} (${pushName || 'sem nome'}): ${texto}`);

      // ── Fluxo multi-etapa (categoria, etc) ───────────────────────────────
      if (this._estados.has(from) && type === 'text') {
        return this._continuarFluxo(from, texto);
      }

      // ── Busca sessão do usuário ───────────────────────────────────────────
      const sessao = await this._buscarSessao(from);
      if (!sessao) return this._responderNaoCadastrado(from);

      const { usuarioId, nome } = sessao;
      await this.processarTexto(from, usuarioId, nome, texto, from);

    } catch (err) {
      console.error('[META] Erro ao processar webhook:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // processarTexto — espelho fiel do handler Baileys
  // ─────────────────────────────────────────────────────────────────────────
  async processarTexto(jid, usuarioId, nome, texto, telefone) {
    const textoLower = texto.toLowerCase().trim();
    const textoClean = textoLower.replace(/[.,!?;:]+$/, '').trim();

    // ── Saudações ──────────────────────────────────────────────────────────
    const saudacoes = ['oi','olá','ola','oi!','olá!','start','hello','bom dia','boa tarde','boa noite'];
    if (saudacoes.includes(textoClean))
      return this.enviar(jid, this.msgBemVindo(nome));

    const padroesPrimeiroContato = [
      /acabei de criar/i, /acabei de me cadastrar/i, /me cadastrei/i, /criei minha conta/i,
    ];
    if (padroesPrimeiroContato.some(p => p.test(textoClean)))
      return this.enviar(jid, this.msgBemVindo(nome));

    // ── Resumo ─────────────────────────────────────────────────────────────
    const triggerResumo = [
      'resumo','saldo','extrato','relatorio','relatório','gerar relatorio',
      'meus gastos','gastos do mes','gastos do mês','quanto gastei','quanto recebi',
      'balanço','balanco',
    ];
    if (triggerResumo.includes(textoClean) || (textoClean.includes('relat') && !textoClean.includes('pdf')))
      return this.enviarResumo(jid, usuarioId, nome);

    // ── Ajuda ──────────────────────────────────────────────────────────────
    if (['ajuda','help','?','menu'].includes(textoClean))
      return this.enviarAjudaComBotoes(jid);

    // ── Categorias ─────────────────────────────────────────────────────────
    if (['categorias','ver categorias','minhas categorias','listar categorias'].includes(textoClean))
      return this.enviarCategorias(jid, usuarioId);

    if (textoClean.startsWith('nova categoria') || textoClean.startsWith('adicionar categoria') || textoClean === 'add categoria')
      return this.iniciarFluxoNovaCategoria(jid, telefone);

    // ── Excluir última ─────────────────────────────────────────────────────
    const regexUltima = /^(excluir?|desfazer|apagar|cancelar|deletar)(\s+a?)?\s+(u[lL]tima|[uú]lt)/i;
    if (regexUltima.test(textoClean) || textoClean === 'desfazer' || textoClean === 'undo')
      return this.excluirUltimaTransacao(jid, usuarioId);

    // ── Excluir por ID ─────────────────────────────────────────────────────
    const matchExcluir = texto.match(
      /^(?:excluir\s+(?:transa[çc][aã]o\s+)?|cancelar\s+|desfazer\s+|deletar\s+|apagar\s+)([A-Z0-9]{2,6})[.,!?;:\s]*$/i
    );
    if (matchExcluir)
      return this.excluirTransacao(jid, usuarioId, matchExcluir[1].toUpperCase());

    // ── Histórico ──────────────────────────────────────────────────────────
    if (['últimas','ultimas','historico','histórico','últimas transações','histórico de transações'].includes(textoClean))
      return this.enviarUltimasTransacoes(jid, usuarioId);

    // ── PDF ────────────────────────────────────────────────────────────────
    const triggerPdf = ['pdf','relatorio pdf','relatório pdf','gerar pdf','exportar pdf'];
    if (triggerPdf.includes(textoClean) || textoClean.includes('pdf'))
      return this.enviar(jid,
        `📄 O relatório em PDF pode ser acessado no painel:\n🌐 *https://www.seusecretario.com.br/dashboard*`
      );

    // ── Agenda — listar ────────────────────────────────────────────────────
    const triggerAgenda = [
      'agenda','compromissos','meus compromissos','ver agenda','ver compromissos',
      'lista de compromissos','lista compromissos','listar compromissos',
    ];
    if (triggerAgenda.includes(textoClean))
      return this.enviarAgenda(jid, usuarioId);

    // ── Agenda — cancelar ──────────────────────────────────────────────────
    const matchCancelarComp = texto.match(
      /^(?:cancelar|deletar|excluir|remover)\s+compromisso\s+([A-Z0-9]{2,6})[.,!?\s]*$/i
    );
    if (matchCancelarComp)
      return this.cancelarCompromisso(jid, usuarioId, matchCancelarComp[1].toUpperCase());

    // ── Dívidas a receber — listar ─────────────────────────────────────────
    const triggerDividas = [
      'a receber','dividas','dívidas','quem me deve','devedores',
      'ver dividas','ver dívidas','lista de devedores',
    ];
    if (triggerDividas.includes(textoClean))
      return this.enviarDividasReceber(jid, usuarioId);

    // ── Dívidas — quitar ───────────────────────────────────────────────────
    const matchQuitar = texto.match(
      /^(?:recebido|recebi|pago|paguei|quitar|quitado|liquidar)\s+([A-Z0-9]{2,6})[.,!?\s]*$/i
    );
    if (matchQuitar)
      return this.quitarDivida(jid, usuarioId, matchQuitar[1].toUpperCase());

    // ── Limites de gastos ──────────────────────────────────────────────────
    const limiteHandled = await this._limitesAlertas.processarComandoLimite(jid, usuarioId, nome, textoClean, texto);
    if (limiteHandled) return;

    // ── IA: dívida a receber ───────────────────────────────────────────────
    const divida = await this.interpretarDivida(texto);
    if (divida)
      return this.registrarDividaReceber(jid, usuarioId, divida, texto);

    // ── Agenda — comando explícito "agendar ..." ───────────────────────────
    const matchAgendar = texto.match(/^agendar\s+(.+)$/i);
    if (matchAgendar) {
      const conteudo = matchAgendar[1].trim();
      const isListar = /^(lista\s+(de\s+)?compromissos?|compromissos?|agenda|tudo|todos?)$/i.test(conteudo);
      if (isListar) return this.enviarAgenda(jid, usuarioId);

      const textoNorm = `tenho compromisso com ${conteudo}`;
      const comp = await this.interpretarCompromisso(textoNorm)
                || await this.interpretarCompromisso(conteudo);
      if (comp) return this.registrarCompromisso(jid, usuarioId, comp, texto);
      return this.enviar(jid,
        `📅 Não consegui entender o compromisso. Tente:\n\n` +
        `• _agendar reunião amanhã às 10h_\n` +
        `• _agendar consulta dia 20 às 14h_`
      );
    }

    // ── IA: compromisso (forma livre) ─────────────────────────────────────
    const compromisso = await this.interpretarCompromisso(texto);
    if (compromisso)
      return this.registrarCompromisso(jid, usuarioId, compromisso, texto);

    // ── IA: transação financeira ───────────────────────────────────────────
    console.log(`🧠 [META] Interpretando: "${texto}"`);
    const transacoes = await this.interpretarTransacao(texto);
    console.log(`🧠 [META] Resultado:`, JSON.stringify(transacoes));

    if (transacoes && transacoes.length > 0) {
      if (transacoes.length === 1) {
        return this.registrarTransacao(jid, usuarioId, transacoes[0], texto, telefone);
      }
      // Múltiplas transações
      await this.enviar(jid, `📋 Encontrei *${transacoes.length} transações*. Registrando...`);
      const registradas = [];
      for (const tx of transacoes) {
        try {
          const idCurto = await this._registrarTransacaoNoBanco(usuarioId, tx, texto, telefone);
          registradas.push({ ...tx, idCurto });
        } catch (err) {
          console.error('[META] Erro ao registrar transação múltipla:', err.message);
        }
      }
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
      return this.enviar(jid, msg);
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    await this.enviar(jid,
      `❓ Não entendi essa mensagem.\n\n` +
      `Tente algo como:\n• _Gastei 50 no mercado_\n• _Recebi 3000 de salário_\n\n` +
      `Ou mande uma *foto* de nota fiscal ou *áudio* descrevendo o gasto.`
    );
    await this.enviarBotoes(jid,
      `O que deseja fazer agora?`,
      [
        { id: 'btn_resumo',    titulo: '📊 Ver resumo' },
        { id: 'btn_agenda',    titulo: '📅 Minha agenda' },
        { id: 'btn_historico', titulo: '🕐 Histórico' },
      ]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // enviar — única função que fala com a API da Meta
  // ─────────────────────────────────────────────────────────────────────────
  async enviar(para, texto) {
    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      console.warn('[META] WA_OFICIAL_ACCESS_TOKEN ou WA_OFICIAL_PHONE_ID não configurado');
      return;
    }
    try {
      await axios.post(GRAPH_URL, {
        messaging_product: 'whatsapp',
        to: para,
        type: 'text',
        text: { body: texto, preview_url: false },
      }, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`[META] Erro ao enviar para ${para}:`, msg);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // enviarInterativo — envia mensagens com botões (reply buttons, lista, CTA)
  // ─────────────────────────────────────────────────────────────────────────
  async enviarInterativo(para, payload) {
    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      console.warn('[META] WA_OFICIAL_ACCESS_TOKEN ou WA_OFICIAL_PHONE_ID não configurado');
      return;
    }
    try {
      await axios.post(GRAPH_URL, {
        messaging_product: 'whatsapp',
        to: para,
        type: 'interactive',
        ...payload,
      }, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`[META] Erro ao enviar interativo para ${para}:`, msg);
    }
  }

  // Envia até 3 botões de resposta rápida
  async enviarBotoes(para, textoCorpo, botoes) {
    // botoes: [{ id: 'string', titulo: 'string' }, ...]  (máx 3)
    await this.enviarInterativo(para, {
      interactive: {
        type: 'button',
        body: { text: textoCorpo },
        action: {
          buttons: botoes.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.titulo.slice(0, 20) },
          })),
        },
      },
    });
  }

  // Envia lista de opções (máx 10 itens)
  async enviarLista(para, textoCorpo, labelBotao, secoes) {
    // secoes: [{ titulo: 'string', itens: [{ id, titulo, descricao? }] }]
    await this.enviarInterativo(para, {
      interactive: {
        type: 'list',
        body: { text: textoCorpo },
        action: {
          button: labelBotao.slice(0, 20),
          sections: secoes.map(s => ({
            title: s.titulo,
            rows: s.itens.slice(0, 10).map(i => ({
              id: i.id,
              title: i.titulo.slice(0, 24),
              ...(i.descricao ? { description: i.descricao.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
  }

  // Envia botão de link externo (CTA URL)
  async enviarBotaoLink(para, textoCorpo, labelBotao, url) {
    await this.enviarInterativo(para, {
      interactive: {
        type: 'cta_url',
        body: { text: textoCorpo },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: labelBotao.slice(0, 20),
            url,
          },
        },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Busca sessão do usuário pelo número (mesmo banco do Baileys)
  // ─────────────────────────────────────────────────────────────────────────
  async _buscarSessao(telefone) {
    // Normaliza: remove DDI 55 se necessário e gera variações
    const variacoes = this._gerarVariacoesTelefone(telefone);

    for (const tel of variacoes) {
      const { rows } = await db.query(
        `SELECT s.usuario_id, u.nome, s.telefone
         FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.telefone = $1`,
        [tel]
      );
      if (rows.length > 0) {
        return {
          usuarioId: rows[0].usuario_id,
          nome:      rows[0].nome.split(' ')[0],
          telefone:  rows[0].telefone,
        };
      }
    }
    return null;
  }

  _gerarVariacoesTelefone(telefone) {
    const variacoes = new Set();
    variacoes.add(telefone);
    const digits  = telefone.replace(/\D/g, '');
    const semDDI  = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
    const comDDI  = '55' + semDDI;
    variacoes.add(semDDI);
    variacoes.add(comDDI);
    if (semDDI.length === 10) {
      const ddd = semDDI.slice(0, 2);
      const num = semDDI.slice(2);
      variacoes.add(ddd + '9' + num);
      variacoes.add('55' + ddd + '9' + num);
    }
    if (semDDI.length === 11 && semDDI[2] === '9') {
      const ddd = semDDI.slice(0, 2);
      const sem9 = ddd + semDDI.slice(3);
      variacoes.add(sem9);
      variacoes.add('55' + sem9);
    }
    return Array.from(variacoes);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trata cliques em botões e seleções de lista
  // ─────────────────────────────────────────────────────────────────────────
  async _processarCliqueBotao(jid, usuarioId, nome, buttonId) {
    console.log(`🔘 [META] Clique de botão: ${buttonId} de ${jid}`);

    switch (buttonId) {
      case 'btn_resumo':
        return this.enviarResumo(jid, usuarioId, nome);

      case 'btn_agenda':
        return this.enviarAgenda(jid, usuarioId);

      case 'btn_historico':
        return this.enviarUltimasTransacoes(jid, usuarioId);

      case 'btn_categorias':
        return this.enviarCategorias(jid, usuarioId);

      case 'btn_a_receber':
        return this.enviarDividasReceber(jid, usuarioId);

      case 'btn_painel':
        return this.enviarBotaoLink(
          jid,
          '📊 Acesse seu painel completo com gráficos e relatórios:',
          '🌐 Abrir painel',
          'https://www.seusecretario.com.br/dashboard'
        );

      default:
        // ID de botão desconhecido — trata como texto normal
        return this.processarTexto(jid, usuarioId, nome, buttonId, jid);
    }
  }

  _responderNaoCadastrado(jid) {
    return this.enviar(jid,
      `Olá! 👋\n\nEste número não está vinculado a nenhuma conta Seu Secretário.\n\n` +
      `Acesse *https://www.seusecretario.com.br* e cadastre-se para começar!`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IA — Transação
  // ─────────────────────────────────────────────────────────────────────────
  async interpretarTransacao(texto) {
    if (!process.env.OPENAI_API_KEY) {
      // Fallback local sem API: detecta categoria por palavras-chave
      return this._detectarTransacaoLocal(texto);
    }
    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 400, temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: texto },
        ],
      }, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const conteudo = resp.data.choices[0].message.content.trim();
      if (!conteudo || conteudo === 'null') return null;
      const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
      if (Array.isArray(parsed)) return parsed.filter(t => t.tipo && t.valor > 0);
      if (parsed?.tipo && parsed.valor > 0) return [parsed];
      return null;
    } catch (err) {
      console.warn('[META] Erro ao interpretar transação:', err.message);
      return null;
    }
  }

  _detectarTransacaoLocal(texto) {
    // Fallback simples: tenta detectar valor + tipo sem IA
    const despesaRe = /(?:gastei|paguei|comprei|devo|conta de|pago)\s+(?:R\$\s*)?(\d+(?:[.,]\d{2})?)/i;
    const receitaRe = /(?:recebi|ganhei|entrou)\s+(?:R\$\s*)?(\d+(?:[.,]\d{2})?)/i;
    const matchD = texto.match(despesaRe);
    const matchR = texto.match(receitaRe);
    if (matchD) return [{ tipo: 'despesa', valor: parseFloat(matchD[1].replace(',', '.')), descricao: texto.trim(), categoria: 'Outros' }];
    if (matchR) return [{ tipo: 'receita', valor: parseFloat(matchR[1].replace(',', '.')), descricao: texto.trim(), categoria: 'Outros' }];
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IA — Dívida
  // ─────────────────────────────────────────────────────────────────────────
  async interpretarDivida(texto) {
    const gatilho = /\b(me deve|deve(?:r)?|emprest(?:ei|ou)|devolver|vai me pagar)\b/i;
    if (!gatilho.test(texto)) return null;
    const falsoPositivo = /\beu devo\b|\bdevo\b/i;
    if (falsoPositivo.test(texto) && !/me deve/i.test(texto)) return null;
    if (!process.env.OPENAI_API_KEY) return null;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const systemPromptDivida = SYSTEM_PROMPT_DIVIDA
      .replace(/{DATA_HOJE}/g, agora.toISOString().split('T')[0])
      .replace(/{ANO_ATUAL}/g, agora.getFullYear());

    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 150, temperature: 0,
        messages: [
          { role: 'system', content: systemPromptDivida },
          { role: 'user',   content: texto },
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
      console.warn('[META] Erro ao interpretar dívida:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IA — Agenda/Compromisso
  // ─────────────────────────────────────────────────────────────────────────
  async interpretarCompromisso(texto) {
    const gatilho = /\b(compromisso|reunião|reuniao|consulta|dentista|médico|medico|agenda|lembr[ae]|amanhã|amanha|sexta|segunda|terça|quarta|quinta|às \d|as \d|\d+h\d*|dia \d)\b/i;
    if (!gatilho.test(texto)) return null;
    const antiGatilho = /\b(gastei|paguei|comprei|recebi|deve|me deve|salário)\b/i;
    if (antiGatilho.test(texto)) return null;
    if (!process.env.OPENAI_API_KEY) return null;

    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const systemPrompt = SYSTEM_PROMPT_AGENDA
      .replace('{DATA_HOJE}', agora.toISOString().split('T')[0])
      .replace('{HORA_ATUAL}', agora.toTimeString().slice(0, 5));

    try {
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 200, temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: texto },
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
      console.warn('[META] Erro ao interpretar compromisso:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Banco — Transações
  // ─────────────────────────────────────────────────────────────────────────
  async _registrarTransacaoNoBanco(usuarioId, tx, textoOriginal, telefone) {
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
    await this._garantirCategoriasPadrao(usuarioId);

    const catRes = await db.query(
      `SELECT id FROM categorias WHERE usuario_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`,
      [usuarioId, tx.categoria || 'Outros']
    );
    const categoriaId = catRes.rows[0]?.id || null;

    const contaRes = await db.query(
      `SELECT id FROM contas WHERE usuario_id = $1 AND padrao = true LIMIT 1`,
      [usuarioId]
    );
    const contaId = contaRes.rows[0]?.id || null;

    let idCurto;
    let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM transacoes WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
    } while (++tentativas < 20);

    await db.query(
      `INSERT INTO transacoes
         (usuario_id, tipo, descricao, valor, categoria_id, conta_id,
          data_vencimento, data_pagamento, pago, origem, id_curto)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, CURRENT_DATE, true, 'whatsapp-oficial', $7)`,
      [usuarioId, tx.tipo, tx.descricao, tx.valor, categoriaId, contaId, idCurto]
    );

    if (contaId) {
      const sinal = tx.tipo === 'receita' ? 1 : -1;
      await db.query(`UPDATE contas SET saldo = saldo + $1 WHERE id = $2`, [sinal * tx.valor, contaId]);
    }

    return idCurto;
  }

  async registrarTransacao(jid, usuarioId, tx, textoOriginal, telefone) {
    try {
      const idCurto = await this._registrarTransacaoNoBanco(usuarioId, tx, textoOriginal, telefone);
      const emoji = tx.tipo === 'despesa' ? '💸' : '💰';
      const emojiCat = EMOJI_CATEGORIA[tx.categoria] || '📦';
      const saldoRes = await db.query(`SELECT SUM(saldo) as total FROM contas WHERE usuario_id = $1`, [usuarioId]);
      const saldo = parseFloat(saldoRes.rows[0]?.total || 0);

      let msg = `${emoji} *${tx.tipo === 'despesa' ? 'Despesa' : 'Receita'} registrada!*\n\n`;
      msg += `📋 *${tx.descricao}*\n`;
      msg += `💵 Valor: *${fmt(tx.valor)}*\n`;
      msg += `${emojiCat} Categoria: ${tx.categoria || 'Outros'}\n`;
      msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💰 Saldo atual: *${fmt(saldo)}*\n`;
      msg += `🔖 ID: *${idCurto}*\n\n`;
      msg += `🗑️ Para excluir: _"excluir ${idCurto}"_\n`;
      msg += `📊 Digite *resumo* para ver seu saldo.`;

      await this.enviar(jid, msg);
      // Botões de ação rápida após registrar transação
      await this.enviarBotoes(jid, 'O que deseja fazer agora?', [
        { id: 'btn_resumo',    titulo: '📊 Ver resumo' },
        { id: 'btn_historico', titulo: '🕐 Histórico' },
        { id: 'btn_painel',    titulo: '🌐 Abrir painel' },
      ]);
    } catch (err) {
      console.error('[META] Erro ao registrar transação:', err.message);
      await this.enviar(jid, '❌ Erro ao registrar transação. Tente novamente.');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Banco — Resumo / Extrato
  // ─────────────────────────────────────────────────────────────────────────
  async enviarResumo(jid, usuarioId, nome) {
    try {
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const mes = agora.getMonth() + 1;
      const ano = agora.getFullYear();

      const { rows: totais } = await db.query(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo='receita' THEN valor END), 0) AS receitas,
          COALESCE(SUM(CASE WHEN tipo='despesa' THEN valor END), 0) AS despesas
        FROM transacoes
        WHERE usuario_id = $1
          AND EXTRACT(MONTH FROM data_pagamento) = $2
          AND EXTRACT(YEAR  FROM data_pagamento) = $3
      `, [usuarioId, mes, ano]);

      const { rows: saldoRows } = await db.query(
        `SELECT COALESCE(SUM(saldo), 0) AS total FROM contas WHERE usuario_id = $1`,
        [usuarioId]
      );

      const { rows: cats } = await db.query(`
        SELECT c.nome AS categoria, COALESCE(SUM(t.valor), 0) AS total
        FROM transacoes t
        LEFT JOIN categorias c ON c.id = t.categoria_id
        WHERE t.usuario_id = $1 AND t.tipo = 'despesa'
          AND EXTRACT(MONTH FROM t.data_pagamento) = $2
          AND EXTRACT(YEAR  FROM t.data_pagamento) = $3
        GROUP BY c.nome
        ORDER BY total DESC LIMIT 3
      `, [usuarioId, mes, ano]);

      const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
      const receitas = parseFloat(totais[0].receitas);
      const despesas = parseFloat(totais[0].despesas);
      const saldo    = parseFloat(saldoRows[0].total);
      const liquido  = receitas - despesas;
      const sinalLiq = liquido >= 0 ? '+' : '';

      let msg = `📊 *Resumo de ${meses[mes - 1]}/${ano}*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💰 Receitas: *${fmt(receitas)}*\n`;
      msg += `💸 Despesas: *${fmt(despesas)}*\n`;
      msg += `📈 Resultado: *${sinalLiq}${fmt(liquido)}*\n`;
      msg += `🏦 Saldo geral: *${fmt(saldo)}*\n`;

      if (cats.length > 0) {
        msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🏆 *Top categorias (despesas):*\n`;
        for (const cat of cats) {
          const emoji = EMOJI_CATEGORIA[cat.categoria] || '📦';
          msg += `${emoji} ${cat.categoria || 'Outros'}: *${fmt(cat.total)}*\n`;
        }
      }

      msg += `\n━━━━━━━━━━━━━━━━━━━━`;
      await this.enviar(jid, msg);
      await this.enviarBotaoLink(
        jid,
        '🌐 Veja gráficos e relatórios completos no painel:',
        '📊 Abrir painel',
        'https://www.seusecretario.com.br/dashboard'
      );
    } catch (err) {
      console.error('[META] Erro ao gerar resumo:', err.message);
      await this.enviar(jid, '❌ Erro ao gerar resumo. Tente novamente.');
    }
  }

  async enviarUltimasTransacoes(jid, usuarioId) {
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
    const { rows } = await db.query(
      `SELECT t.id_curto, t.descricao, t.valor, t.tipo, c.nome AS categoria, t.data_pagamento
       FROM transacoes t LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1 ORDER BY t.criado_em DESC LIMIT 5`,
      [usuarioId]
    );
    if (rows.length === 0) return this.enviar(jid, '📭 Nenhuma transação registrada ainda.');
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
    msg += `━━━━━━━━━━━━━━━━━━━━\n🗑️ Para excluir:\n• _excluir última_\n• _excluir [ID]_ — Ex: excluir A3B`;
    await this.enviar(jid, msg);
  }

  async excluirUltimaTransacao(jid, usuarioId) {
    const { rows } = await db.query(
      `SELECT id, descricao, valor, tipo, conta_id, id_curto FROM transacoes WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 1`,
      [usuarioId]
    );
    if (rows.length === 0) return this.enviar(jid, '📭 Você não tem nenhuma transação para excluir.');
    const tx = rows[0];
    if (tx.conta_id) {
      const sinal = tx.tipo === 'receita' ? -1 : 1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * tx.valor, tx.conta_id]);
    }
    await db.query(`DELETE FROM transacoes WHERE id = $1`, [tx.id]);
    await this.enviar(jid,
      `🗑️ *Última transação excluída!*\n\n📋 ${tx.descricao}\n💵 ${fmt(tx.valor)}\n` +
      (tx.id_curto ? `🔖 ID: ${tx.id_curto}\n` : '') +
      `\n✅ Saldo atualizado. Digite *resumo* para ver.`
    );
  }

  async excluirTransacao(jid, usuarioId, idCurto) {
    await db.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS id_curto TEXT`).catch(() => {});
    const { rows } = await db.query(
      `SELECT id, descricao, valor, tipo, conta_id FROM transacoes WHERE usuario_id = $1 AND UPPER(id_curto) = $2`,
      [usuarioId, idCurto]
    );
    if (rows.length === 0)
      return this.enviar(jid, `❌ Transação *${idCurto}* não encontrada.\n\nDigite *histórico* para ver suas últimas.`);
    const tx = rows[0];
    if (tx.conta_id) {
      const sinal = tx.tipo === 'receita' ? -1 : 1;
      await db.query('UPDATE contas SET saldo = saldo + $1 WHERE id = $2', [sinal * tx.valor, tx.conta_id]);
    }
    await db.query(`DELETE FROM transacoes WHERE id = $1`, [tx.id]);
    await this.enviar(jid,
      `🗑️ *Transação excluída!*\n\n📋 ${tx.descricao}\n💵 ${fmt(tx.valor)}\n🔖 ID: ${idCurto}\n\n✅ Saldo atualizado.`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Banco — Categorias
  // ─────────────────────────────────────────────────────────────────────────
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
      ).catch(() => {});
    }
  }

  async enviarCategorias(jid, usuarioId) {
    await this._garantirCategoriasPadrao(usuarioId);
    const { rows } = await db.query(
      `SELECT DISTINCT ON (LOWER(nome)) nome FROM categorias WHERE usuario_id = $1 ORDER BY LOWER(nome) ASC`,
      [usuarioId]
    );
    if (rows.length === 0) return this.enviar(jid, '📂 Você ainda não tem categorias.');

    // Usa lista interativa (até 10 itens por seção)
    const itens = rows.map(row => ({
      id: `cat_${row.nome.toLowerCase().replace(/\s+/g, '_').slice(0, 20)}`,
      titulo: `${EMOJI_CATEGORIA[row.nome] || '📦'} ${row.nome}`,
    }));

    // Divide em seções de até 10 itens (limite da API)
    const secoes = [];
    for (let i = 0; i < itens.length; i += 10) {
      secoes.push({ titulo: 'Categorias', itens: itens.slice(i, i + 10) });
    }

    await this.enviarLista(
      jid,
      `📂 *Suas Categorias*\n\nSelecione uma categoria para ver os gastos, ou adicione uma nova digitando _nova categoria_.`,
      '📂 Ver categorias',
      secoes
    );
  }

  async iniciarFluxoNovaCategoria(jid, telefone) {
    this._estados.set(telefone, { tipo: 'nova_categoria', etapa: 'aguardando_nome' });
    await this.enviar(jid, `➕ *Nova Categoria*\n\nQual será o nome da nova categoria?\n\n_Ex: Pets, Jogos, Presente_`);
  }

  async _continuarFluxo(telefone, texto) {
    const estado = this._estados.get(telefone);
    if (!estado) return;

    if (['cancelar', 'sair'].includes(texto.toLowerCase().trim())) {
      this._estados.delete(telefone);
      return this.enviar(telefone, '❌ Operação cancelada.');
    }

    if (estado.tipo === 'nova_categoria') {
      const sessao = await this._buscarSessao(telefone);
      if (!sessao) { this._estados.delete(telefone); return; }

      if (estado.etapa === 'aguardando_nome') {
        const nome = texto.trim();
        if (nome.length < 2 || nome.length > 50)
          return this.enviar(telefone, '⚠️ Nome inválido. Use entre 2 e 50 caracteres.');
        estado.nomeCategoria = nome;
        estado.etapa = 'aguardando_confirmacao';
        this._estados.set(telefone, estado);
        return this.enviar(telefone, `📋 Confirma a criação da categoria *"${nome}"*?\n\nResponda *sim* ou *não*.`);
      }

      if (estado.etapa === 'aguardando_confirmacao') {
        if (['sim', 's', 'yes', 'confirmar'].includes(texto.toLowerCase().trim())) {
          await db.query(
            `INSERT INTO categorias (usuario_id, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [sessao.usuarioId, estado.nomeCategoria]
          ).catch(() => {});
          this._estados.delete(telefone);
          return this.enviar(telefone, `✅ Categoria *"${estado.nomeCategoria}"* criada!`);
        }
        this._estados.delete(telefone);
        return this.enviar(telefone, '❌ Criação cancelada.');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Banco — Dívidas a Receber
  // ─────────────────────────────────────────────────────────────────────────
  async _garantirTabelaDividas() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS dividas_receber (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL, devedor TEXT NOT NULL,
        descricao TEXT, valor NUMERIC(12,2) NOT NULL,
        data_vencimento DATE, data_recebimento DATE,
        status TEXT NOT NULL DEFAULT 'pendente',
        origem TEXT DEFAULT 'whatsapp', mensagem_raw TEXT,
        id_curto TEXT, criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
  }

  async registrarDividaReceber(jid, usuarioId, divida, textoOriginal) {
    await this._garantirTabelaDividas();
    let idCurto; let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM dividas_receber WHERE id_curto = $1`, [idCurto]);
      if (existe.rows.length === 0) break;
    } while (++tentativas < 20);

    const vencimento = divida.data_vencimento || null;
    const vencimentoFmt = vencimento
      ? new Date(vencimento + 'T12:00:00').toLocaleDateString('pt-BR')
      : 'Não definido';

    await db.query(
      `INSERT INTO dividas_receber (usuario_id, devedor, descricao, valor, data_vencimento, origem, mensagem_raw, id_curto)
       VALUES ($1, $2, $3, $4, $5, 'whatsapp-oficial', $6, $7)`,
      [usuarioId, divida.devedor, divida.descricao || `${divida.devedor} te deve`, divida.valor, vencimento, textoOriginal, idCurto]
    );

    await this.enviar(jid,
      `💸 *Dívida registrada!*\n\n👤 Devedor: *${divida.devedor}*\n💵 Valor: *${fmt(divida.valor)}*\n` +
      `📅 Vencimento: ${vencimentoFmt}\n\n━━━━━━━━━━━━━━━━━━━━\n🔖 ID: *${idCurto}*\n\n` +
      `✅ Quando receber: _"recebido ${idCurto}"_\n📋 Ver todas: _"a receber"_`
    );
  }

  async enviarDividasReceber(jid, usuarioId) {
    await this._garantirTabelaDividas();
    const { rows } = await db.query(
      `SELECT id_curto, devedor, valor, data_vencimento FROM dividas_receber
       WHERE usuario_id = $1 AND status = 'pendente'
       ORDER BY data_vencimento ASC NULLS LAST, criado_em DESC`,
      [usuarioId]
    );
    const { rows: totais } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN status='pendente' THEN valor END), 0) AS pendente FROM dividas_receber WHERE usuario_id = $1`,
      [usuarioId]
    );
    if (rows.length === 0)
      return this.enviar(jid, `✅ *Nenhuma dívida pendente!*\n\nPara registrar:\n_"Bruno me deve 50 reais"_`);

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    let msg = `💸 *Dívidas a Receber*\n━━━━━━━━━━━━━━━━━━━━\n💰 Total pendente: *${fmt(totais[0].pendente)}*\n\n`;
    for (const d of rows) {
      let vencLabel = '📅 Sem data'; let alertEmoji = '';
      if (d.data_vencimento) {
        const venc = new Date(d.data_vencimento + 'T12:00:00');
        const diff = Math.round((venc - hoje) / 86400000);
        const dataFmt = venc.toLocaleDateString('pt-BR');
        if (diff < 0)      { vencLabel = `📅 Venceu ${dataFmt}`; alertEmoji = '🔴 '; }
        else if (diff === 0) { vencLabel = `📅 Vence HOJE`; alertEmoji = '🟡 '; }
        else                 { vencLabel = `📅 ${dataFmt}`; }
      }
      msg += `${alertEmoji}👤 *${d.devedor}* — ${fmt(d.valor)}\n   ${vencLabel} | 🔖 *${d.id_curto}*\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n✅ Para marcar: _"recebido [ID]"_`;
    await this.enviar(jid, msg);
  }

  async quitarDivida(jid, usuarioId, idCurto) {
    const { rows } = await db.query(
      `UPDATE dividas_receber SET status='recebido', data_recebimento=CURRENT_DATE
       WHERE usuario_id=$1 AND UPPER(id_curto)=$2 AND status='pendente' RETURNING *`,
      [usuarioId, idCurto]
    );
    if (rows.length === 0)
      return this.enviar(jid, `❌ Dívida *${idCurto}* não encontrada ou já quitada.`);

    const d = rows[0];
    const contaRes = await db.query(`SELECT id FROM contas WHERE usuario_id=$1 AND padrao=true LIMIT 1`, [usuarioId]);
    const contaId = contaRes.rows[0]?.id || null;
    await db.query(
      `INSERT INTO transacoes (usuario_id, tipo, descricao, valor, conta_id, data_vencimento, data_pagamento, pago, origem)
       VALUES ($1, 'receita', $2, $3, $4, CURRENT_DATE, CURRENT_DATE, true, 'whatsapp-oficial')`,
      [usuarioId, `Recebido de ${d.devedor}`, d.valor, contaId]
    );
    if (contaId) await db.query(`UPDATE contas SET saldo = saldo + $1 WHERE id = $2`, [d.valor, contaId]);
    await this.enviar(jid,
      `✅ *Recebimento confirmado!*\n\n👤 *${d.devedor}*\n💵 *${fmt(d.valor)}*\n\n💰 Receita registrada!\nDigite _"a receber"_ para ver as demais.`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Banco — Agenda
  // ─────────────────────────────────────────────────────────────────────────
  async _garantirTabelaAgenda() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS agenda (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL, titulo TEXT NOT NULL,
        data_hora TIMESTAMPTZ NOT NULL, lembrar_antes INT NOT NULL DEFAULT 30,
        local TEXT, notas TEXT,
        lembrete_enviado BOOLEAN NOT NULL DEFAULT FALSE,
        cancelado BOOLEAN NOT NULL DEFAULT FALSE,
        id_curto TEXT, origem TEXT DEFAULT 'whatsapp',
        google_event_id TEXT, criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS google_event_id TEXT`).catch(() => {});
  }

  async registrarCompromisso(jid, usuarioId, compromisso, textoOriginal) {
    await this._garantirTabelaAgenda();
    let idCurto; let tentativas = 0;
    do {
      idCurto = gerarIdCurto();
      const existe = await db.query(`SELECT id FROM agenda WHERE id_curto=$1`, [idCurto]);
      if (existe.rows.length === 0) break;
    } while (++tentativas < 20);

    const dataHora = new Date(compromisso.data_hora.replace(' ', 'T') + ':00-03:00');
    await db.query(
      `INSERT INTO agenda (usuario_id, titulo, data_hora, lembrar_antes, local, notas, id_curto, origem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'whatsapp-oficial')`,
      [usuarioId, compromisso.titulo, dataHora.toISOString(), compromisso.lembrar_antes || 30,
       compromisso.local || null, compromisso.notas || null, idCurto]
    );

    const dataFmt = dataHora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaFmt = dataHora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const lembrarLabel = (compromisso.lembrar_antes || 30) >= 60
      ? `${(compromisso.lembrar_antes || 30) / 60}h antes`
      : `${compromisso.lembrar_antes || 30} minutos antes`;

    let msg = `📅 *Compromisso agendado!*\n\n📌 *${compromisso.titulo}*\n`;
    msg += `📅 Data: *${dataFmt}*\n🕐 Hora: *${horaFmt}*\n`;
    if (compromisso.local) msg += `📍 Local: ${compromisso.local}\n`;
    if (compromisso.notas) msg += `📝 Notas: ${compromisso.notas}\n`;
    msg += `🔔 Lembrete: ${lembrarLabel}\n\n━━━━━━━━━━━━━━━━━━━━\n🔖 ID: *${idCurto}*\n\n`;
    msg += `❌ Para cancelar: _"cancelar compromisso ${idCurto}"_\n📋 Ver todos: _"agenda"_`;
    await this.enviar(jid, msg);
  }

  async enviarAgenda(jid, usuarioId) {
    await this._garantirTabelaAgenda();
    const { rows } = await db.query(
      `SELECT id_curto, titulo, data_hora, local
       FROM agenda
       WHERE usuario_id=$1 AND cancelado=false AND data_hora >= NOW() - INTERVAL '1 hour'
       ORDER BY data_hora ASC LIMIT 10`,
      [usuarioId]
    );
    if (rows.length === 0)
      return this.enviar(jid,
        `📅 *Sua agenda está vazia!*\n\nPara adicionar:\n` +
        `_"Tenho reunião amanhã às 10h"_\n_"Consulta médica dia 20 às 14h"_`
      );

    const agora = new Date();
    let msg = `📅 *Seus Compromissos*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const comp of rows) {
      const dh = new Date(comp.data_hora);
      const dataFmt = dh.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      const horaFmt = dh.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      const diffMin = Math.round((dh - agora) / 60000);
      let statusEmoji = '📌';
      if (diffMin < 0)         statusEmoji = '✅';
      else if (diffMin < 60)   statusEmoji = '🟡';
      else if (diffMin < 1440) statusEmoji = '🔵';
      msg += `${statusEmoji} *${comp.titulo}*\n   📅 ${dataFmt} às ${horaFmt}`;
      if (comp.local) msg += ` | 📍 ${comp.local}`;
      msg += `\n   🔖 *${comp.id_curto}*\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n❌ Para cancelar: _"cancelar compromisso [ID]"_`;
    await this.enviar(jid, msg);
  }

  async cancelarCompromisso(jid, usuarioId, idCurto) {
    const { rows } = await db.query(
      `UPDATE agenda SET cancelado=true WHERE usuario_id=$1 AND UPPER(id_curto)=$2 AND cancelado=false RETURNING titulo, data_hora`,
      [usuarioId, idCurto]
    );
    if (rows.length === 0)
      return this.enviar(jid, `❌ Compromisso *${idCurto}* não encontrado ou já cancelado.`);
    const dh = new Date(rows[0].data_hora);
    await this.enviar(jid,
      `🗑️ *Compromisso cancelado!*\n\n📌 ${rows[0].titulo}\n` +
      `📅 ${dh.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} às ` +
      `${dh.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lembretes de agenda (loop independente do Baileys)
  // ─────────────────────────────────────────────────────────────────────────
  iniciarLembretes() {
    if (this._timerLembretes) return;
    console.log('⏰ [META] Loop de lembretes iniciado (1min)');
    this._timerLembretes = setInterval(() => this._verificarLembretes(), 60 * 1000);
    this._verificarLembretes();
  }

  pararLembretes() {
    if (this._timerLembretes) {
      clearInterval(this._timerLembretes);
      this._timerLembretes = null;
      console.log('⏰ [META] Loop de lembretes parado.');
    }
  }

  async _verificarLembretes() {
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
          AND a.origem = 'whatsapp-oficial'
      `);

      for (const comp of rows) {
        try {
          const dh       = new Date(comp.data_hora);
          const dataFmt  = dh.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
          const horaFmt  = dh.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          const diffMin  = Math.round((dh - new Date()) / 60000);
          const tempoLabel = diffMin <= 0 ? '⚠️ *AGORA!*' : diffMin < 60 ? `em *${diffMin} minutos*` : `em *${Math.round(diffMin / 60)}h*`;

          let msg = `🔔 *Lembrete!*\n\n📌 *${comp.titulo}*\n📅 ${dataFmt} às ${horaFmt} — ${tempoLabel}\n`;
          if (comp.local) msg += `📍 ${comp.local}\n`;
          msg += `\n🔖 ID: *${comp.id_curto}*\n_Para cancelar: "cancelar compromisso ${comp.id_curto}"_`;

          await this.enviar(comp.telefone, msg);
          await db.query(`UPDATE agenda SET lembrete_enviado=true WHERE id=$1`, [comp.id]);
          console.log(`🔔 [META] Lembrete enviado: ${comp.titulo} → ${comp.telefone}`);
        } catch (err) {
          console.error(`[META] Erro ao enviar lembrete ${comp.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[META] Erro ao verificar lembretes:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mídia — Download via Graph API + Whisper / GPT-4o Vision
  // ─────────────────────────────────────────────────────────────────────────
  async _baixarMidiaMeta(mediaId) {
    if (!ACCESS_TOKEN) return null;
    try {
      // 1. Obtém URL temporária do arquivo
      const infoRes = await axios.get(
        `https://graph.facebook.com/v20.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 10000 }
      );
      const url = infoRes.data?.url;
      if (!url) return null;

      // 2. Baixa o arquivo
      const fileRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      return Buffer.from(fileRes.data);
    } catch (err) {
      console.error('[META] Erro ao baixar mídia:', err.message);
      return null;
    }
  }

  async _transcreverAudioMeta(mediaId) {
    if (!process.env.OPENAI_API_KEY || !mediaId) return null;
    const fs       = require('fs');
    const path     = require('path');
    const FormData = require('form-data');
    const TMP_DIR  = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

    const buffer = await this._baixarMidiaMeta(mediaId);
    if (!buffer) return null;

    const tmpFile = path.join(TMP_DIR, `audio_meta_${Date.now()}.ogg`);
    try {
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
      console.error('[META] Erro ao transcrever áudio:', err.message);
      return null;
    } finally {
      if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch {} }
    }
  }

  async _analisarImagemMeta(mediaId) {
    if (!process.env.OPENAI_API_KEY || !mediaId) return null;
    const buffer = await this._baixarMidiaMeta(mediaId);
    if (!buffer) return null;
    try {
      const base64 = buffer.toString('base64');
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini', max_tokens: 300, temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
            { type: 'text', text: 'Analise esta imagem e extraia a transação financeira.' },
          ]},
        ],
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
      const conteudo = resp.data.choices[0].message.content.trim();
      if (!conteudo || conteudo === 'null') return null;
      const parsed = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      console.error('[META] Erro ao analisar imagem:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mensagens fixas
  // ─────────────────────────────────────────────────────────────────────────
  msgBemVindo(nome) {
    return (
      `🎉 Olá, *${nome}*! Seja bem-vindo(a) ao *Seu Secretário*! 👋\n\n` +
      `🤖 Sou seu assistente pessoal. Estou aqui para te ajudar a organizar sua vida financeira, ` +
      `sua agenda e muito mais — tudo direto pelo WhatsApp!\n\n` +
      `Escreva *ajuda* que te ensino como usar 😊`
    );
  }

  msgAjuda() {
    return (
      `🤖 *Comandos disponíveis:*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 *Registrar transações:*\n` +
      `_Gastei 50 no mercado_\n_Recebi 3000 de salário_\n\n` +
      `🎤 *Áudio:* Mande um áudio falando o gasto\n` +
      `📸 *Foto:* Tire foto de nota fiscal\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 *Agenda:*\n` +
      `_"agendar reunião amanhã às 10h"_\n` +
      `_"agendar consulta médica dia 20 às 14h"_\n` +
      `_agenda_ — ver compromissos\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 *Dívidas a Receber:*\n` +
      `_"Bruno me deve 40, paga dia 30"_ — registra\n` +
      `_a receber_ — lista devedores\n` +
      `_"recebido [ID]"_ — quita\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *resumo* — Saldo e relatório\n` +
      `🕐 *histórico* — Últimas transações\n` +
      `📂 *categorias* — Suas categorias\n` +
      `🎯 *limite* — Definir limites de gastos\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 Painel: *https://www.seusecretario.com.br/dashboard*`
    );
  }

  // Envia o menu de ajuda com botões de ação rápida
  async enviarAjudaComBotoes(jid) {
    const texto =
      `🤖 *O que deseja fazer?*\n\n` +
      `💸 Registre gastos e receitas por texto, áudio ou foto\n` +
      `📅 Agende compromissos e receba lembretes\n` +
      `📊 Veja resumos e relatórios do seu mês\n\n` +
      `Ou escolha uma opção abaixo:`;

    await this.enviarBotoes(jid, texto, [
      { id: 'btn_resumo',    titulo: '📊 Ver resumo' },
      { id: 'btn_agenda',    titulo: '📅 Minha agenda' },
      { id: 'btn_historico', titulo: '🕐 Histórico' },
    ]);
  }
}

module.exports = BotOficial;
