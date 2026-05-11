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
const { gerarRelatorio, limparPdfsAntigos } = require('./relatorio');

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
        // Avisa imediatamente e transcreve em paralelo
        const mediaId = message.audio?.id;
        const [, transcricao] = await Promise.all([
          this.enviarDigitando(from).catch(() => {}),
          this._transcreverAudioMeta(mediaId),
        ]);
        texto = transcricao;
        if (!texto) return this.enviar(from, '❌ Não consegui entender o áudio. Tente enviar texto.');
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

    // ── PDF ──────────────────────────────────────────────────────────────────────
    const triggerPdf = ['pdf','relatorio pdf','relatório pdf','gerar pdf','exportar pdf','relatorio mensal','relatório mensal'];
    if (triggerPdf.includes(textoClean) || textoClean.includes('pdf'))
      return this.enviarRelatorioPdf(jid, usuarioId, nome);

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
    // processarComandoLimite retorna true/false; _enviarMenuLimites é chamado internamente
    // Patch: se o texto é exatamente um trigger de "ver limites", chama direto para garantir o await
    const TRIGGER_LIMITES = ['limite','limites','meus limites','ver limite','ver limites','limite de gastos','limites de gastos','configurar limite','configurar limites'];
    if (TRIGGER_LIMITES.includes(textoClean)) {
      await this._limitesAlertas._enviarMenuLimites(jid, usuarioId, nome);
      return;
    }
    const limiteHandled = await this._limitesAlertas.processarComandoLimite(jid, usuarioId, nome, textoClean, texto);
    if (limiteHandled) return;

    // ── Gastos fixos ───────────────────────────────────────────────────────
    const triggerGastosFixos = ['gastos fixos','gasto fixo','contas fixas','conta fixa','fixos mensais','gastos mensais'];
    if (triggerGastosFixos.includes(textoClean) || textoClean.startsWith('gastos fixos') || textoClean.startsWith('gasto fixo'))
      return this.enviarGastosFixos(jid, usuarioId);

    // ── Novo gasto fixo ────────────────────────────────────────────────────
    const matchNovoFixo = texto.match(/^(?:add|adicionar|novo|criar)s+(?:gasto|conta)s+fixo?s+(.+)/i);
    if (matchNovoFixo)
      return this.iniciarFluxoNovoGastoFixo(jid, telefone, matchNovoFixo[1].trim());

    // ── Excluir gasto fixo ─────────────────────────────────────────────────
    const matchExcluirFixo = texto.match(/^(?:excluir|remover|deletar|apagar)s+(?:gasto|conta)s+fixo?s+([A-Z0-9]{2,6})/i);
    if (matchExcluirFixo)
      return this.excluirGastoFixo(jid, usuarioId, matchExcluirFixo[1].toUpperCase());

    // ── Relatório por categoria ────────────────────────────────────────────
    {
      // Padrões aceitos:
      // "gasto em gasolina", "gastos com combustível", "quanto de gasolina gastei"
      // "quanto gastei de gasolina", "quanto gastei esse mês gasolina"
      // "quanto gastei de gasolina esse mês ?", "ver gastos transporte", "relatório alimentação"

      // Helper: remove sufixos temporais e pontuação que o usuário pode adicionar
      // Ex: "gasolina esse mês ?" → "gasolina"
      //     "uber no mês passado" → "uber"  (futuro: tratado como mês atual por enquanto)
      const _limparTermoCategoria = (termo) => {
        return termo
          .replace(/\s*[?!.]+$/, '')                                                        // pontuação final
          .replace(/\s+(?:esse|este|nesse|neste|no|do|na|da)\s+m[eê]s\b.*/i, '')           // "esse mês ..."
          .replace(/\s+(?:essa|esta|nessa|nesta|na|da)\s+semana\b.*/i, '')                  // "essa semana ..."
          .replace(/\s+(?:hoje|agora|recente|recentemente|até\s+agora)\b.*/i, '')           // "hoje", "agora"
          .replace(/\s+(?:no\s+m[eê]s\s+passado|m[eê]s\s+passado)\b.*/i, '')              // "mês passado"
          .replace(/\s+(?:essa|esta|nessa|nesta)\s+semana\b.*/i, '')                        // "esta semana"
          .replace(/\s*[?!.]+$/, '')                                                        // segunda passagem (segurança)
          .trim();
      };

      const recat =
        texto.match(/^quanto\s+de\s+(.+?)\s+(?:gastei|eu\s+gastei)/i)     // "quanto de X gastei"
        || texto.match(/^quanto\s+(?:eu\s+)?gastei\s+(?:de|em|com|no|na)\s+(.+)/i) // "quanto gastei de X"
        || texto.match(/^(?:gastos?|ver\s+gastos?|mostrar\s+gastos?|relat[oó]rio)\s+(?:em|com|de|no|na)?\s*(.+)$/i) // "gasto em X"
        || texto.match(/^(?:quanto\s+gastei)\s+(.+)$/i);                    // "quanto gastei X"
      if (recat) {
        const termoLimpo = _limparTermoCategoria(recat[1]);
        if (termoLimpo) return this.enviarRelatorioPorCategoria(jid, usuarioId, termoLimpo);
      }
    }

    // ── Submenu quem me deve ───────────────────────────────────────────────
    if (['quem me deve','quem deve','devedores','dividas','dívidas','a receber'].includes(textoClean))
      return this.enviarMenuQuemMeDeve(jid, usuarioId);

    // ── Submenu gastos fixos (texto) ────────────────────────────────────────
    if (['menu gastos fixos','configurar gastos fixos','gastos fixos menu'].includes(textoClean))
      return this.enviarMenuGastosFixos(jid, usuarioId);

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
            reply: { id: b.id, title: [...(b.titulo||'')].slice(0,20).join('') },
          })),
        },
      },
    });
  }

  // Envia lista de opções — LIMITE HARD da Meta: 10 rows TOTAIS por lista
  async enviarLista(para, textoCorpo, labelBotao, secoes) {
    // secoes: [{ titulo: 'string', itens: [{ id, titulo, descricao? }] }]
    // Garante nunca ultrapassar 10 rows totais (API Meta rejeita com #131009)
    let rowsRestantes = 10;
    const secoesLimitadas = secoes
      .filter(s => s.itens && s.itens.length > 0)
      .map(s => ({ ...s, itens: s.itens.slice(0, rowsRestantes) }))
      .filter(s => { rowsRestantes -= s.itens.length; return s.itens.length > 0 && rowsRestantes >= 0; });

    await this.enviarInterativo(para, {
      interactive: {
        type: 'list',
        body: { text: textoCorpo.slice(0, 4096) },
        action: {
          button: [...(labelBotao||'')].slice(0,20).join(''),
          sections: secoesLimitadas.map(s => ({

            title: [...(s.titulo||'')].slice(0,24).join(''),
            rows: s.itens.slice(0, 10).map(i => ({
              id: i.id,
              title: [...(i.titulo||'')].slice(0,24).join(''),
              ...(i.descricao ? { description: [...(i.descricao||'')].slice(0,72).join('') } : {}),
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

      case 'btn_gastos_fixos':
        return this.enviarGastosFixos(jid, usuarioId);

      case 'btn_limite':
        // Chama _enviarMenuLimites diretamente para evitar o bug do operador vírgula
        return this._limitesAlertas._enviarMenuLimites(jid, usuarioId, nome);

      case 'btn_a_receber':
      case 'menu_receber_ver':
        return this.enviarDividasReceber(jid, usuarioId);

      case 'menu_receber_add':
        return this.enviar(jid,
          `➕ *Adicionar dívida*\n\n` +
          `Diga quem te deve, quanto e quando recebe:\n` +
          `_"João me deve 200, recebo dia 20"_\n` +
          `_"Maria me deve 150"_`
        );

      case 'menu_receber_lembrete':
        return this.enviarLembreteDevedores(jid, usuarioId);

      case 'btn_menu_quem_deve':
        return this.enviarMenuQuemMeDeve(jid, usuarioId);

      case 'btn_menu_gastos_fixos':
        return this.enviarMenuGastosFixos(jid, usuarioId);

      case 'btn_menu_principal':
        return this.enviarAjudaComBotoes(jid);

      case 'btn_pdf':
        return this.enviarRelatorioPdf(jid, usuarioId, nome);

      case 'btn_painel':
        return this.enviarBotaoLink(
          jid,
          '📊 Acesse seu painel completo com gráficos e relatórios:',
          '🌐 Abrir painel',
          'https://www.seusecretario.com.br/dashboard'
        );

      case 'btn_gastos_fixos_add':
        return this.iniciarFluxoNovoGastoFixo(jid, jid, '');

      case 'fluxo_fixo_internet':
        return this.iniciarFluxoNovoGastoFixo(jid, jid, 'Internet');

      case 'fluxo_fixo_aluguel':
        return this.iniciarFluxoNovoGastoFixo(jid, jid, 'Aluguel');

      case 'fluxo_fixo_outro':
        return this.iniciarFluxoNovoGastoFixo(jid, jid, '');

      default: {
        // Clique em categoria → relatório de gastos da categoria no mês
        if (buttonId.startsWith('cat_')) {
          const catSlug = buttonId.replace('cat_', '').replace(/_/g, ' ');
          // Busca nome real no banco
          const { rows: catFound } = await db.query(
            `SELECT nome FROM categorias WHERE usuario_id=$1 AND LOWER(REPLACE(nome,' ','_')) = LOWER($2) LIMIT 1`,
            [usuarioId, buttonId.replace('cat_', '')]
          );
          const catNome = catFound[0]?.nome || catSlug;
          return this.enviarRelatorioPorCategoria(jid, usuarioId, catNome);
        }

        // Seleção de categoria para gasto fixo (fixo_cat_*)
        if (buttonId.startsWith('fixo_cat_')) {
          const estado = this._estados.get(jid);
          if (estado && estado.tipo === 'novo_gasto_fixo' && estado.etapa === 'aguardando_categoria') {
            // Encontra nome real da categoria pelo id
            const catKey = buttonId.replace('fixo_cat_', '').replace(/_/g, ' ');
            const catEncontrada = CATEGORIAS_PADRAO.find(c =>
              c.nome.toLowerCase().replace(/s+/g, '_').slice(0, 15) === buttonId.replace('fixo_cat_', '')
            );
            estado.categoria = catEncontrada ? catEncontrada.nome : catKey;
            estado.etapa = 'aguardando_confirmacao_fixo';
            this._estados.set(jid, estado);
            return this.enviar(jid,
              `✅ Confirmar o gasto fixo?

🏠 *${estado.descricao}*
` +
              `💵 *${this._fmt(estado.valor)}*/mês
` +
              (estado.dia ? `📅 Vence dia ${estado.dia}
` : '') +
              `📂 Categoria: *${estado.categoria}*

` +
              `Responda *sim* para confirmar ou *não* para cancelar.`
            );
          }
        }
        // ID de botão desconhecido — trata como texto normal
        return this.processarTexto(jid, usuarioId, nome, buttonId, jid);
      }
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
    let msg = `🕐 *Últimas transações:*\n━━━━━━━━━━━━━━━━━━━━\n`;
    for (const tx of rows) {
      const emoji = tx.tipo === 'despesa' ? '💸' : '💰';
      const data = tx.data_pagamento
        ? new Date(tx.data_pagamento).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit' })
        : '—';
      // Abrevia descrição (máx 22 chars) e categoria (máx 12 chars)
      const desc = tx.descricao.length > 22 ? tx.descricao.slice(0, 21) + '…' : tx.descricao;
      const cat  = (tx.categoria || 'Outros').length > 12 ? (tx.categoria || 'Outros').slice(0, 11) + '…' : (tx.categoria || 'Outros');
      msg += `${emoji} *${desc}* — ${fmt(tx.valor)}\n`;
      msg += `   🏷️ ${cat} | 📅 ${data}`;
      if (tx.id_curto) msg += ` | 🔖 *${tx.id_curto}*`;
      msg += `\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n🗑️ Excluir: _excluir última_ ou _excluir [ID]_`;
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
    if (rows.length === 0) return this.enviar(jid, '📂 Você ainda não tem categorias. Digite _nova categoria_ para criar.');

    // Monta mensagem de texto com todas as categorias
    let msg = `📂 *Suas Categorias*\n━━━━━━━━━━━━━━━━━━━━\n`;
    for (const row of rows) {
      const emoji = EMOJI_CATEGORIA[row.nome] || '📦';
      msg += `${emoji} ${row.nome}\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔍 Ver gastos de uma categoria:\n`;
    msg += `   _"gasto em Transporte"_\n`;
    msg += `   _"gasto em Alimentação"_\n\n`;
    msg += `➕ Criar nova: _nova categoria_\n`;
    msg += `🎯 Definir limite: _limite_`;

    await this.enviar(jid, msg);

    // Tenta enviar lista interativa também (permite clicar para ver gastos da categoria)
    try {
      const itens = rows.map(row => ({
        id: `cat_${row.nome.toLowerCase().replace(/\s+/g, '_').slice(0, 20)}`,
        titulo: `${EMOJI_CATEGORIA[row.nome] || '📦'} ${row.nome}`,
        descricao: 'Ver gastos do mês',
      }));
      const secoes = [];
      for (let i = 0; i < itens.length; i += 10) {
        secoes.push({ titulo: 'Ver gastos por categoria', itens: itens.slice(i, i + 10) });
      }
      await this.enviarLista(jid, '👇 Toque para ver os gastos de uma categoria:', '📂 Selecionar', secoes);
    } catch (_) { /* lista opcional — texto já foi enviado */ }
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

    if (estado.tipo === 'novo_gasto_fixo') {
      return this._continuarFluxoGastoFixo(telefone, texto, estado);
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
      // 1. Obtém URL temporária do arquivo (timeout apertado — falha rápido)
      const infoRes = await axios.get(
        `https://graph.facebook.com/v20.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 7000 }
      );
      const url = infoRes.data?.url;
      if (!url) return null;

      // 2. Baixa o arquivo
      const fileRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      return Buffer.from(fileRes.data);
    } catch (err) {
      console.error('[META] Erro ao baixar mídia:', err.message);
      return null;
    }
  }

  async _transcreverAudioMeta(mediaId) {
    if (!process.env.OPENAI_API_KEY || !mediaId) return null;
    const FormData = require('form-data');

    // Baixa URL e arquivo em paralelo não é possível (URL vem antes), mas
    // eliminamos o arquivo temporário — passa o buffer direto ao Whisper
    const buffer = await this._baixarMidiaMeta(mediaId);
    if (!buffer) return null;

    try {
      const form = new FormData();
      // Passa o buffer diretamente — sem escrita em disco
      form.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
      form.append('model', 'whisper-1');
      form.append('language', 'pt');
      form.append('response_format', 'text');

      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return typeof resp.data === 'string' ? resp.data.trim() : resp.data?.text?.trim() || null;
    } catch (err) {
      console.error('[META] Erro ao transcrever áudio:', err.message);
      return null;
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
  // PDF — Geração e envio do relatório mensal
  // ─────────────────────────────────────────────────────────────────────────
  async enviarRelatorioPdf(jid, usuarioId, nome) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    await this.enviar(jid, `⏳ Gerando seu relatório PDF de *${meses[mes-1]}/${ano}*... Aguarde!`);

    try {
      limparPdfsAntigos();
      const { outputPath, dados } = await gerarRelatorio(usuarioId, mes, ano);

      const fs2    = require('fs');
      const axios2 = require('axios');
      const FormData = require('form-data');

      if (!process.env.WA_OFICIAL_ACCESS_TOKEN || !process.env.WA_OFICIAL_PHONE_ID) {
        return this.enviar(jid, '❌ Configuração da API incompleta para envio de PDF.');
      }

      // 1. Faz upload do PDF para a API da Meta (media upload)
      const form = new FormData();
      form.append('file', fs2.createReadStream(outputPath), {
        filename: `relatorio_${meses[mes-1].toLowerCase()}_${ano}.pdf`,
        contentType: 'application/pdf',
      });
      form.append('messaging_product', 'whatsapp');
      form.append('type', 'application/pdf');

      const uploadRes = await axios2.post(
        `https://graph.facebook.com/v20.0/${process.env.WA_OFICIAL_PHONE_ID}/media`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${process.env.WA_OFICIAL_ACCESS_TOKEN}`,
          },
          timeout: 60000,
        }
      );

      const mediaId = uploadRes.data?.id;
      if (!mediaId) throw new Error('Upload de mídia falhou: sem media_id');

      // 2. Envia o documento via WhatsApp
      const recebido  = parseFloat(dados.totais.recebido || 0);
      const pago      = parseFloat(dados.totais.pago || 0);
      const saldo     = recebido - pago;
      const sinalSaldo = saldo >= 0 ? '+' : '';

      await axios2.post(
        `https://graph.facebook.com/v20.0/${process.env.WA_OFICIAL_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: jid,
          type: 'document',
          document: {
            id: mediaId,
            filename: `Relatorio_${meses[mes-1]}_${ano}.pdf`,
            caption:
              `📊 *Relatório ${meses[mes-1]}/${ano}*

` +
              `💰 Receitas: *${this._fmt(recebido)}*
` +
              `💸 Despesas: *${this._fmt(pago)}*
` +
              `📈 Resultado: *${sinalSaldo}${this._fmt(saldo)}*

` +
              `📄 Relatório completo em PDF com todas as transações.`,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WA_OFICIAL_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      // 3. Limpa o arquivo temporário
      try { fs2.unlinkSync(outputPath); } catch {}

      console.log(`[META] PDF enviado para ${jid}`);

    } catch (err) {
      console.error('[META] Erro ao gerar/enviar PDF:', err.message);
      // Fallback: envia resumo texto + link do painel
      await this.enviar(jid,
        `❌ Não foi possível gerar o PDF agora.

` +
        `Tente novamente ou acesse o painel web para baixar:
` +
        `🌐 *https://www.seusecretario.com.br/dashboard*`
      );
    }
  }


  // ─────────────────────────────────────────────────────────────────────────
  // Gastos Fixos Mensais
  // ─────────────────────────────────────────────────────────────────────────
  async _garantirTabelaGastosFixos() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS gastos_fixos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL,
        descricao TEXT NOT NULL,
        valor NUMERIC(12,2) NOT NULL,
        categoria TEXT NOT NULL DEFAULT 'Outros',
        dia_vencimento INT DEFAULT 1,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        id_curto TEXT,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
  }

  async enviarGastosFixos(jid, usuarioId) {
    await this._garantirTabelaGastosFixos();
    const { rows } = await db.query(
      `SELECT id_curto, descricao, valor, categoria, dia_vencimento
       FROM gastos_fixos WHERE usuario_id = $1 AND ativo = true
       ORDER BY dia_vencimento ASC, descricao ASC`,
      [usuarioId]
    );

    const totalFixo = rows.reduce((acc, r) => acc + parseFloat(r.valor), 0);

    let msg = `🏠 *Gastos Fixos Mensais*
━━━━━━━━━━━━━━━━━━━━
`;

    if (rows.length === 0) {
      msg += `
Você ainda não tem gastos fixos cadastrados.

`;
    } else {
      msg += `💰 Total mensal: *${this._fmt(totalFixo)}*

`;
      for (const r of rows) {
        const emoji = EMOJI_CATEGORIA[r.categoria] || '📦';
        const dia = r.dia_vencimento ? `Vence dia ${r.dia_vencimento}` : '';
        msg += `${emoji} *${r.descricao}* — ${this._fmt(r.valor)}
`;
        if (dia) msg += `   📅 ${dia} | `;
        else msg += `   `;
        msg += `🔖 *${r.id_curto}*

`;
      }
      msg += `━━━━━━━━━━━━━━━━━━━━
`;
    }

    msg += `➕ Para adicionar: _"add gasto fixo [nome] [valor]"_
`;
    msg += `   Ex: _"add gasto fixo Internet 90"_
`;
    msg += `🗑️ Para remover: _"excluir gasto fixo [ID]"_`;

    await this.enviar(jid, msg);

    if (rows.length === 0) {
      await this.enviarBotoes(jid, '👇 Adicione seu primeiro gasto fixo:', [
        { id: 'fluxo_fixo_internet', titulo: '🌐 Internet/Telefone' },
        { id: 'fluxo_fixo_aluguel',  titulo: '🏠 Aluguel/Moradia' },
        { id: 'fluxo_fixo_outro',    titulo: '➕ Outro gasto fixo' },
      ]);
    } else {
      await this.enviarBotoes(jid, 'O que deseja fazer?', [
        { id: 'btn_gastos_fixos_add', titulo: '➕ Adicionar novo' },
        { id: 'btn_resumo',           titulo: '📊 Ver resumo' },
        { id: 'btn_historico',        titulo: '🕐 Histórico' },
      ]);
    }
  }

  async iniciarFluxoNovoGastoFixo(jid, telefone, textoInicial) {
    const matchValor = textoInicial.match(/^(.+?)\s+R?\$?\s*(\d+(?:[.,]\d{1,2})?)$/i);
    if (matchValor) {
      const descricao = matchValor[1].trim();
      const valor = parseFloat(matchValor[2].replace(',', '.'));
      this._estados.set(telefone, { tipo: 'novo_gasto_fixo', etapa: 'aguardando_dia', descricao, valor });
      return this.enviar(telefone,
        `🏠 *Novo Gasto Fixo*

📋 *${descricao}*
💵 *${this._fmt(valor)}*

` +
        `Qual o dia do vencimento? (1-31)
_Digite o número ou "sem data" para pular_`
      );
    }
    this._estados.set(telefone, { tipo: 'novo_gasto_fixo', etapa: 'aguardando_nome' });
    await this.enviar(telefone,
      `🏠 *Novo Gasto Fixo*

Qual o nome do gasto fixo?

_Ex: Internet, Aluguel, Energia, Netflix_`
    );
  }

  async _continuarFluxoGastoFixo(telefone, texto, estado) {
    const sessao = await this._buscarSessao(telefone);
    if (!sessao) { this._estados.delete(telefone); return; }

    if (estado.etapa === 'aguardando_nome') {
      estado.descricao = texto.trim();
      estado.etapa = 'aguardando_valor';
      this._estados.set(telefone, estado);
      return this.enviar(telefone, `💵 Qual o valor mensal de *${estado.descricao}*?

_Ex: 150 ou 150,00_`);
    }

    if (estado.etapa === 'aguardando_valor') {
      const valor = parseFloat(texto.replace(',', '.').replace(/[^0-9.]/g, ''));
      if (!valor || valor <= 0) return this.enviar(telefone, '⚠️ Valor inválido. Digite apenas o número, ex: 150');
      estado.valor = valor;
      estado.etapa = 'aguardando_dia';
      this._estados.set(telefone, estado);
      return this.enviar(telefone, `📅 Qual o dia do vencimento? (1-31)
_Digite o número ou "sem data" para pular_`);
    }

    if (estado.etapa === 'aguardando_dia') {
      let dia = null;
      if (!['sem data','nao','nao','pular','skip'].includes(texto.toLowerCase().trim())) {
        dia = parseInt(texto);
        if (isNaN(dia) || dia < 1 || dia > 31)
          return this.enviar(telefone, '⚠️ Dia inválido. Digite um número de 1 a 31 ou "sem data".');
      }
      estado.dia = dia;
      estado.etapa = 'aguardando_categoria';
      this._estados.set(telefone, estado);
      const categoriasOpcoes = CATEGORIAS_PADRAO.filter(c => c.tipo !== 'receita').map(c => ({
        id: `fixo_cat_${c.nome.toLowerCase().replace(/\s+/g, '_').slice(0, 15)}`,
        titulo: `${EMOJI_CATEGORIA[c.nome] || '📦'} ${c.nome}`,
      }));
      return this.enviarLista(
        telefone,
        `📂 Qual a categoria de *${estado.descricao}*?`,
        '📂 Escolher categoria',
        [{ titulo: 'Categorias', itens: categoriasOpcoes.slice(0, 10) }]
      );
    }

    if (estado.etapa === 'aguardando_confirmacao_fixo') {
      if (['sim','s','yes','confirmar'].includes(texto.toLowerCase().trim())) {
        await this._salvarGastoFixo(telefone, sessao.usuarioId, estado);
      } else {
        this._estados.delete(telefone);
        await this.enviar(telefone, '❌ Gasto fixo não cadastrado.');
      }
    }
  }

  async _salvarGastoFixo(telefone, usuarioId, estado) {
    await this._garantirTabelaGastosFixos();
    let idCurto; let t = 0;
    do {
      idCurto = gerarIdCurto();
      const ex = await db.query('SELECT id FROM gastos_fixos WHERE id_curto=$1', [idCurto]);
      if (ex.rows.length === 0) break;
    } while (++t < 20);

    await db.query(
      `INSERT INTO gastos_fixos (usuario_id, descricao, valor, categoria, dia_vencimento, id_curto)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [usuarioId, estado.descricao, estado.valor, estado.categoria || 'Outros', estado.dia || null, idCurto]
    );
    this._estados.delete(telefone);
    await this.enviar(telefone,
      `✅ *Gasto fixo cadastrado!*

🏠 *${estado.descricao}*
` +
      `💵 *${this._fmt(estado.valor)}*/mês
` +
      (estado.dia ? `📅 Vence dia ${estado.dia}
` : '') +
      `📂 Categoria: ${estado.categoria || 'Outros'}
` +
      `🔖 ID: *${idCurto}*

` +
      `🗑️ Para remover: _"excluir gasto fixo ${idCurto}"_
` +
      `🏠 Ver todos: _"gastos fixos"_`
    );
  }

  async excluirGastoFixo(jid, usuarioId, idCurto) {
    await this._garantirTabelaGastosFixos();
    const { rows } = await db.query(
      `UPDATE gastos_fixos SET ativo=false
       WHERE usuario_id=$1 AND UPPER(id_curto)=$2 AND ativo=true
       RETURNING descricao, valor`,
      [usuarioId, idCurto]
    );
    if (rows.length === 0)
      return this.enviar(jid, `❌ Gasto fixo *${idCurto}* não encontrado.`);
    await this.enviar(jid,
      `🗑️ *Gasto fixo removido!*

🏠 ${rows[0].descricao}
💵 ${this._fmt(rows[0].valor)}/mês

` +
      `Digite *gastos fixos* para ver os demais.`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Relatório por Categoria
  // ─────────────────────────────────────────────────────────────────────────
  async enviarRelatorioPorCategoria(jid, usuarioId, nomeCategoria) {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const MESES_LABEL = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    // Nomes exatos de categorias — quando o usuário digitar exatamente isso,
    // busca TODA a categoria. Qualquer outra coisa (ex: "gasolina", "uber")
    // busca na DESCRIÇÃO da transação.
    const NOMES_CATEGORIA = [
      'transporte','alimentação','alimentacao','mercado','saúde','saude',
      'assinatura','casa','educação','educacao','vestuário','vestuario',
      'cuidados pessoais','pets','viagem','impostos','lazer','lazer e entretenimento',
      'salário','salario','freelance','outros','investimentos',
    ];

    const termoLower = nomeCategoria.toLowerCase().trim();

    // Verifica se o termo bate exatamente com um nome de categoria do banco do usuário
    const { rows: catExata } = await db.query(
      `SELECT nome FROM categorias WHERE usuario_id = $1 AND LOWER(nome) = LOWER($2) LIMIT 1`,
      [usuarioId, termoLower]
    );

    // Também verifica se bate com os nomes padrão
    const ehCategoria = catExata.length > 0 || NOMES_CATEGORIA.includes(termoLower);

    let whereCategoria, params, tituloBusca;

    if (ehCategoria) {
      // Usuário quer VER TODA A CATEGORIA (ex: "transporte", "alimentação")
      const nomeReal = catExata[0]?.nome || nomeCategoria;
      whereCategoria = `LOWER(COALESCE(c.nome, 'outros')) = LOWER($2)`;
      params = [usuarioId, nomeReal, mes, ano];
      tituloBusca = nomeReal;
    } else {
      // Usuário quer gastos com um ITEM ESPECÍFICO (ex: "gasolina", "uber", "netflix")
      // Busca apenas na descrição da transação
      whereCategoria = `LOWER(t.descricao) LIKE LOWER($2)`;
      params = [usuarioId, `%${termoLower}%`, mes, ano];
      tituloBusca = nomeCategoria;
    }

    const { rows: transacoes } = await db.query(
      `SELECT t.descricao, t.valor, t.data_pagamento, t.id_curto, c.nome AS categoria
       FROM transacoes t
       LEFT JOIN categorias c ON c.id = t.categoria_id
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND ${whereCategoria}
         AND EXTRACT(MONTH FROM t.data_pagamento) = $3
         AND EXTRACT(YEAR  FROM t.data_pagamento) = $4
       ORDER BY t.data_pagamento DESC`,
      params
    );

    const total    = transacoes.reduce((acc, t2) => acc + parseFloat(t2.valor), 0);
    const catLabel  = transacoes.length > 0 ? (transacoes[0].categoria || tituloBusca) : tituloBusca;
    const emoji     = EMOJI_CATEGORIA[catLabel] || '📦';
    const mesLabel  = MESES_LABEL[mes - 1] + '/' + ano;

    if (transacoes.length === 0) {
      // Tenta o mês anterior como sugestão
      const mesAnterior = mes === 1 ? 12 : mes - 1;
      const anoAnterior = mes === 1 ? ano - 1 : ano;
      const { rows: contagem } = await db.query(
        `SELECT COUNT(*) AS qtd, COALESCE(SUM(t.valor),0) AS total
         FROM transacoes t
         LEFT JOIN categorias c ON c.id = t.categoria_id
         WHERE t.usuario_id = $1
           AND t.tipo = 'despesa'
           AND ${whereCategoria}
           AND EXTRACT(MONTH FROM t.data_pagamento) = $3
           AND EXTRACT(YEAR  FROM t.data_pagamento) = $4`,
        [usuarioId, params[1], mesAnterior, anoAnterior]
      );
      const qtdAnt = parseInt(contagem[0]?.qtd || 0);
      const totAnt = parseFloat(contagem[0]?.total || 0);

      let msg = `${emoji} *Gastos em "${tituloBusca}"*
`;
      msg += `📅 ${mesLabel}
`;
      msg += `━━━━━━━━━━━━━━━━━━━━
`;
      msg += `Nenhum gasto encontrado neste mês.

`;
      if (qtdAnt > 0) {
        msg += `📌 No mês anterior (${MESES_LABEL[mesAnterior-1]}): *${this._fmt(totAnt)}* em ${qtdAnt} lançamento(s).

`;
      }
      msg += `💡 Exemplos:
• _gasto em gasolina_ → só gasolina
• _gasto em Transporte_ → tudo de transporte`;
      return this.enviar(jid, msg);
    }

    let msg = `${emoji} *Gastos em ${tituloBusca}*
`;
    if (!ehCategoria) msg += `📂 _Categoria: ${catLabel}_
`;
    msg += `📅 ${mesLabel}
`;
    msg += `━━━━━━━━━━━━━━━━━━━━
`;
    msg += `💰 Total: *${this._fmt(total)}*
`;
    msg += `📊 Lançamentos: *${transacoes.length}*

`;

    for (const tx of transacoes) {
      const data = tx.data_pagamento
        ? new Date(tx.data_pagamento).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day:'2-digit', month:'2-digit' })
        : '—';
      msg += `💸 *${tx.descricao}* — ${this._fmt(tx.valor)}
`;
      msg += `   📅 ${data}`;
      if (tx.id_curto) msg += ` | 🔖 *${tx.id_curto}*`;
      msg += `

`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━
`;
    msg += `🔍 Outra categoria: _"gasto em [nome]"_
`;
    msg += `📊 Resumo geral: _resumo_`;

    await this.enviar(jid, msg);
  }

  // Envia lembrete de cobrança para devedores pendentes
  async enviarLembreteDevedores(jid, usuarioId) {
    const { rows } = await db.query(
      `SELECT id_curto, nome_devedor, valor, data_prevista
       FROM dividas_receber
       WHERE usuario_id=$1 AND quitado=false
       ORDER BY data_prevista ASC NULLS LAST
       LIMIT 10`,
      [usuarioId]
    ).catch(() => ({ rows: [] }));

    if (rows.length === 0)
      return this.enviar(jid, `✅ Nenhuma dívida pendente para lembrar!`);

    let msg = `🔔 *Devedores pendentes*\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `Quais dívidas deseja enviar lembrete?\n` +
           `Digite: _"lembrar [ID]"_\n` +
           `Ou: _"lembrar todos"_ para cobrar todos\n\n`;
    for (const d of rows) {
      const venc = d.data_prevista
        ? new Date(d.data_prevista).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' })
        : 'sem data';
      msg += `👤 *${d.nome_devedor}* — ${this._fmt(d.valor)} | 📅 ${venc} | 🔖 *${d.id_curto}*\n`;
    }
    await this.enviar(jid, msg);
  }

  _fmt(v) {
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
      `🎯 *limite* — Definir limites de gastos\n` +
      `🏠 *gastos fixos* — Configurar gastos mensais fixos\n` +
      `🔍 *gasto em [categoria]* — Ex: _gasto em gasolina_\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 Painel: *https://www.seusecretario.com.br/dashboard*`
    );
  }

  // ── Menu Principal — 5 botões de acesso rápido ────────────────────────────
  async enviarAjudaComBotoes(jid) {
    const corpo =
      `🤖 *Seu Secretário — Menu Principal*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 Registre gastos e receitas por texto, áudio ou foto\n` +
      `📅 Agende compromissos e receba lembretes\n` +
      `📊 Veja resumos, relatórios e gastos fixos\n` +
      `👥 Gerencie quem te deve dinheiro\n` +
      `⚙️ Configure gastos fixos mensais\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Escolha uma seção abaixo 👇`;

    await this.enviarLista(jid, corpo, '📋 Abrir menu', [
      {
        titulo: '💸 Financeiro',
        itens: [
          { id: 'btn_resumo',    titulo: '📊 Resumo do mês',     descricao: 'Saldo, receitas e despesas' },
          { id: 'btn_historico', titulo: '🕐 Histórico',         descricao: 'Últimas 5 transações' },
          { id: 'btn_limite',    titulo: '🎯 Limites de gastos', descricao: 'Alertas por categoria' },
          { id: 'btn_pdf',       titulo: '📄 Relatório PDF',     descricao: 'Relatório completo do mês' },
        ],
      },
      {
        titulo: '📅 Agenda',
        itens: [
          { id: 'btn_agenda', titulo: '📅 Minha agenda', descricao: 'Próximos compromissos' },
        ],
      },
      {
        titulo: '👥 Quem me deve',
        itens: [
          { id: 'menu_receber_ver', titulo: '📋 Ver devedores',    descricao: 'Quem ainda te deve' },
          { id: 'menu_receber_add', titulo: '➕ Adicionar dívida', descricao: 'Registrar novo devedor' },
        ],
      },
      {
        titulo: '⚙️ Gastos Fixos',
        itens: [
          { id: 'btn_gastos_fixos',     titulo: '📋 Ver gastos fixos', descricao: 'Suas contas mensais' },
          { id: 'btn_gastos_fixos_add', titulo: '➕ Novo gasto fixo',  descricao: 'Nova conta mensal' },
        ],
      },
      {
        titulo: '🌐 Outros',
        itens: [
          { id: 'btn_painel', titulo: '🌐 Painel web', descricao: 'Graficos e relatorios completos' },
        ],
      },
    ]);
    // Nota: limite da API Meta = 10 rows totais por lista
  }

  // ── Submenu: Quem me deve ──────────────────────────────────────────────────
  async enviarMenuQuemMeDeve(jid, usuarioId) {
    // Conta pendências para exibir no header
    const { rows } = await db.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor),0) AS total
       FROM dividas_receber WHERE usuario_id=$1 AND quitado=false`,
      [usuarioId]
    ).catch(() => ({ rows: [{ qtd: 0, total: 0 }] }));
    const qtd   = parseInt(rows[0]?.qtd || 0);
    const total = parseFloat(rows[0]?.total || 0);

    const corpo = qtd > 0
      ? `👥 *Quem me deve — Menu*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${qtd}* pessoa(s) te devem no total *${this._fmt(total)}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Gerencie as pessoas que te devem dinheiro.`
      : `👥 *Quem me deve — Menu*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Nenhuma dívida pendente no momento.\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Gerencie as pessoas que te devem dinheiro.`;

    await this.enviarBotoes(jid, corpo, [
      { id: 'menu_receber_ver',     titulo: '📋 Ver devedores' },
      { id: 'menu_receber_add',     titulo: '➕ Adicionar dívida' },
      { id: 'menu_receber_lembrete',titulo: '🔔 Enviar lembrete' },
    ]);
  }

  // ── Submenu: Gastos Fixos ──────────────────────────────────────────────────
  async enviarMenuGastosFixos(jid, usuarioId) {
    await this._garantirTabelaGastosFixos();
    const { rows } = await db.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor),0) AS total
       FROM gastos_fixos WHERE usuario_id=$1 AND ativo=true`,
      [usuarioId]
    ).catch(() => ({ rows: [{ qtd: 0, total: 0 }] }));
    const qtd   = parseInt(rows[0]?.qtd || 0);
    const total = parseFloat(rows[0]?.total || 0);

    const corpo = qtd > 0
      ? `⚙️ *Gastos Fixos — Menu*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *${qtd}* gasto(s) fixo(s) | Total: *${this._fmt(total)}/mês*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Configure suas contas mensais fixas.`
      : `⚙️ *Gastos Fixos — Menu*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Nenhum gasto fixo cadastrado.\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Configure suas contas mensais fixas.`;

    await this.enviarBotoes(jid, corpo, [
      { id: 'btn_gastos_fixos',     titulo: '📋 Ver gastos fixos' },
      { id: 'btn_gastos_fixos_add', titulo: '➕ Adicionar novo' },
      { id: 'btn_menu_principal',   titulo: '🔙 Menu principal' },
    ]);
  }
}

module.exports = BotOficial;
