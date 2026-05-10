// ============================================================================
// limites_alertas.js — Limites de Gastos + Alertas Automáticos
// Seu Secretário — Bot WhatsApp Financeiro
//
// COMO INTEGRAR AO handler.js:
//   1. No topo do handler.js, adicione:
//        const { LimitesAlertas } = require('./limites_alertas');
//
//   2. No construtor da classe BotSeuSecretario, adicione:
//        this._limitesAlertas = new LimitesAlertas(this);
//        this._timerAlertas = null;
//
//   3. Em _iniciarChecagemLembretes(), após a linha existente, adicione:
//        this._timerAlertas = setInterval(
//          () => this._limitesAlertas.verificarAlertasAutomaticos(),
//          60 * 60 * 1000   // roda a cada 1 hora
//        );
//        this._limitesAlertas.verificarAlertasAutomaticos(); // roda na inicialização
//
//   4. Em _pararChecagemLembretes(), adicione:
//        if (this._timerAlertas) {
//          clearInterval(this._timerAlertas);
//          this._timerAlertas = null;
//        }
//
//   5. Em processarTexto(), ANTES do bloco de interpretarDivida, adicione:
//        const limiteHandled = await this._limitesAlertas.processarComandoLimite(remoteJid, usuarioId, nome, textoClean, texto);
//        if (limiteHandled) return;
//
//   6. Em msgAjuda(), adicione na seção de comandos:
//        `• *limite* — Ver e definir limites de gastos\n`
//
//   7. Em msgTutorial(), adicione no bloco de comandos úteis:
//        `• *limite* — Definir limite de gastos por categoria\n`
// ============================================================================

const db = require('../database/db');

// ── Helpers de formatação ────────────────────────────────────────────────────
const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const EMOJI_CATEGORIA = {
  'Alimentação': '🍔', 'Saúde': '🏥', 'Assinatura': '📱',
  'Transporte': '🚗', 'Viagem': '✈️', 'Doações': '🤝',
  'Impostos': '🧾', 'Mercado': '🛒', 'Educação': '📚',
  'Cuidados pessoais': '💅', 'Lazer e Entretenimento': '🎉',
  'Vestuário': '👗', 'Pets': '🐾', 'Casa': '🏠',
  'Salário': '💰', 'Freelance': '💼', 'Outros': '📦',
};

// ── Thresholds de alertas automáticos ───────────────────────────────────────
// O alerta de limite dispara quando o gasto atingir esses % do limite definido
const THRESHOLD_AVISO  = 0.80; // 80%  → aviso amarelo
const THRESHOLD_CRITICO = 1.00; // 100% → alerta vermelho (estourou)

class LimitesAlertas {
  constructor(bot) {
    this.bot = bot; // referência ao BotSeuSecretario para usar this.bot.enviar(...)
  }

  // ── Criação das tabelas necessárias ────────────────────────────────────────
  async _garantirTabelas() {
    // Tabela de limites de gastos por categoria (ou global)
    await db.query(`
      CREATE TABLE IF NOT EXISTS limites_gastos (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id   UUID NOT NULL,
        categoria    TEXT,          -- NULL = limite global mensal
        periodo      TEXT NOT NULL DEFAULT 'mensal',  -- 'mensal' | 'semanal'
        valor_limite NUMERIC(12,2) NOT NULL,
        ativo        BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em    TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (usuario_id, categoria, periodo)
      )
    `).catch(() => {});

    // Tabela de controle de alertas enviados (evita spam repetido)
    await db.query(`
      CREATE TABLE IF NOT EXISTS alertas_enviados (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id   UUID NOT NULL,
        tipo_alerta  TEXT NOT NULL,   -- 'limite_80', 'limite_100', 'comparativo_semanal'
        referencia   TEXT NOT NULL,   -- ex: '2025-W23-Alimentação'
        enviado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_alertas_enviados
      ON alertas_enviados (usuario_id, tipo_alerta, referencia)
    `).catch(() => {});
  }

  // ── Verifica se um alerta já foi enviado para evitar repetição ─────────────
  async _alertaJaEnviado(usuarioId, tipoAlerta, referencia) {
    const res = await db.query(
      `SELECT id FROM alertas_enviados
       WHERE usuario_id = $1 AND tipo_alerta = $2 AND referencia = $3`,
      [usuarioId, tipoAlerta, referencia]
    );
    return res.rows.length > 0;
  }

  async _marcarAlertaEnviado(usuarioId, tipoAlerta, referencia) {
    await db.query(
      `INSERT INTO alertas_enviados (usuario_id, tipo_alerta, referencia)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [usuarioId, tipoAlerta, referencia]
    );
  }

  // ── Busca o JID do WhatsApp de um usuário (para envio proativo) ────────────
  async _buscarJidUsuario(usuarioId) {
    const res = await db.query(
      `SELECT s.telefone FROM sessoes_bot s WHERE s.usuario_id = $1 LIMIT 1`,
      [usuarioId]
    );
    if (res.rows.length === 0) return null;
    const tel = res.rows[0].telefone;
    return `55${tel}@s.whatsapp.net`;
  }

  // ── Gastos do mês atual por categoria ─────────────────────────────────────
  async _gastosMesAtual(usuarioId, categoria = null) {
    const params = [usuarioId];
    let catClause = '';
    if (categoria) {
      params.push(categoria);
      catClause = `AND LOWER(t.categoria) = LOWER($${params.length})`;
    }
    const res = await db.query(
      `SELECT COALESCE(SUM(t.valor), 0) AS total
       FROM transacoes t
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND date_trunc('month', t.criado_em AT TIME ZONE 'America/Sao_Paulo')
             = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
         ${catClause}`,
      params
    );
    return parseFloat(res.rows[0].total);
  }

  // ── Gastos de uma semana específica (ISO week) ─────────────────────────────
  async _gastosSemana(usuarioId, semanaOffset = 0) {
    // semanaOffset 0 = semana atual, -1 = semana passada
    const res = await db.query(
      `SELECT COALESCE(SUM(t.valor), 0) AS total
       FROM transacoes t
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND date_trunc('week', t.criado_em AT TIME ZONE 'America/Sao_Paulo')
             = date_trunc('week', (NOW() AT TIME ZONE 'America/Sao_Paulo') + ($2 * INTERVAL '1 week'))`,
      [usuarioId, semanaOffset]
    );
    return parseFloat(res.rows[0].total);
  }

  // ── Gastos por categoria na semana atual ──────────────────────────────────
  async _gastosPorCategoriaSemana(usuarioId, semanaOffset = 0) {
    const res = await db.query(
      `SELECT t.categoria, COALESCE(SUM(t.valor), 0) AS total
       FROM transacoes t
       WHERE t.usuario_id = $1
         AND t.tipo = 'despesa'
         AND date_trunc('week', t.criado_em AT TIME ZONE 'America/Sao_Paulo')
             = date_trunc('week', (NOW() AT TIME ZONE 'America/Sao_Paulo') + ($2 * INTERVAL '1 week'))
       GROUP BY t.categoria
       ORDER BY total DESC`,
      [usuarioId, semanaOffset]
    );
    return res.rows; // [{categoria, total}]
  }

  // ── Semana ISO atual (ex: "2025-W23") ─────────────────────────────────────
  _semanaLabel(offsetSemanas = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetSemanas * 7);
    const ano = d.getFullYear();
    const inicio = new Date(d.getFullYear(), 0, 1);
    const semana = Math.ceil(((d - inicio) / 86400000 + inicio.getDay() + 1) / 7);
    return `${ano}-W${String(semana).padStart(2, '0')}`;
  }

  // ── Mês atual (ex: "2025-06") ─────────────────────────────────────────────
  _mesLabel() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FUNÇÃO 1 — DEFINIR / VER LIMITES (comandos do usuário)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Ponto de entrada chamado em processarTexto() antes de interpretarDivida.
   * Retorna true se o comando foi tratado aqui (para o handler parar de processar).
   */
  async processarComandoLimite(remoteJid, usuarioId, nome, textoClean, textoOriginal) {
    await this._garantirTabelas();

    // ── Ver limites ──────────────────────────────────────────────────────────
    const triggerVerLimites = [
      'limite', 'limites', 'meus limites', 'ver limite', 'ver limites',
      'limite de gastos', 'limites de gastos', 'configurar limite', 'configurar limites',
    ];
    if (triggerVerLimites.includes(textoClean))
      await this._enviarMenuLimites(remoteJid, usuarioId, nome);
      return true;

    // ── Remover limite ───────────────────────────────────────────────────────
    // "remover limite alimentação" | "excluir limite global"
    const matchRemover = textoClean.match(
      /^(?:remover|excluir|deletar|apagar)\s+limite\s*(.*)$/i
    );
    if (matchRemover) {
      const alvo = matchRemover[1].trim();
      await this._removerLimite(remoteJid, usuarioId, alvo);
      return true;
    }

    // ── Definir limite ───────────────────────────────────────────────────────
    // Formatos aceitos:
    //   "limite mensal 2000"                       → global mensal
    //   "limite semanal 500"                       → global semanal
    //   "limite alimentação 500"                   → categoria mensal (padrão)
    //   "limite mensal alimentação 500"            → categoria mensal
    //   "limite semanal transporte 300"            → categoria semanal
    //   "definir limite mensal de 2000"            → global mensal
    //   "quero gastar no máximo 1500 por mês"      → global mensal (linguagem natural)
    const matchDefinir = textoOriginal.match(
      /(?:definir\s+|setar\s+|configurar\s+|set\s+)?limite\s+(?:(mensal|semanal)\s+)?(?:de\s+)?([a-záéíóúàèìòùãõâêîôûç\s]+?)?\s*(?:de\s+)?(?:R\$\s?)?([\d]+(?:[.,]\d+)?)\s*(?:reais?|por\s+(?:m[eê]s|semana))?/i
    ) || textoOriginal.match(
      /(?:gastar|gasto)\s+(?:no\s+m[aá]ximo|até|ate)\s+(?:R\$\s?)?([\d]+(?:[.,]\d+)?)\s*(?:reais?)?\s*(?:por\s+(m[eê]s|semana))?/i
    );

    if (matchDefinir) {
      let periodo, categoriaRaw, valorRaw;

      if (matchDefinir[0].includes('máximo') || matchDefinir[0].includes('maximo') || matchDefinir[0].includes('até') || matchDefinir[0].includes('ate')) {
        // linguagem natural: "quero gastar no máximo 1500 por mês"
        valorRaw = matchDefinir[1];
        periodo = (matchDefinir[2] && matchDefinir[2].includes('semana')) ? 'semanal' : 'mensal';
        categoriaRaw = null;
      } else {
        // forma explícita: "limite mensal alimentação 500"
        periodo = matchDefinir[1] ? matchDefinir[1].toLowerCase() : 'mensal';
        categoriaRaw = matchDefinir[2] ? matchDefinir[2].trim() : null;
        valorRaw = matchDefinir[3];
      }

      // Limpa a categoria: remove palavras genéricas que não são categoria
      const PALAVRAS_IGNORAR = ['de', 'do', 'da', 'global', 'total', 'geral', 'gasto', 'gastos', ''];
      const categoria = categoriaRaw && !PALAVRAS_IGNORAR.includes(categoriaRaw.toLowerCase())
        ? this._normalizarCategoria(categoriaRaw)
        : null;

      // Remove pontos de milhar (formato BR: "1.000" → "1000") antes de converter
      const valor = parseFloat(valorRaw.replace(/\./g, '').replace(',', '.'));
      if (isNaN(valor) || valor <= 0) return false;

      await this._definirLimite(remoteJid, usuarioId, categoria, periodo, valor);
      return true;
    }

    return false; // comando não reconhecido → handler continua normalmente
  }

  // ── Normaliza o nome da categoria para bater com o banco ──────────────────
  _normalizarCategoria(texto) {
    if (!texto) return null;
    const mapa = {
      'alimentacao': 'Alimentação', 'alimentação': 'Alimentação', 'comida': 'Alimentação',
      'saude': 'Saúde', 'saúde': 'Saúde', 'farmacia': 'Saúde', 'médico': 'Saúde', 'medico': 'Saúde',
      'assinatura': 'Assinatura', 'netflix': 'Assinatura', 'spotify': 'Assinatura',
      'transporte': 'Transporte', 'uber': 'Transporte', 'gasolina': 'Transporte',
      'viagem': 'Viagem',
      'mercado': 'Mercado', 'supermercado': 'Mercado',
      'educacao': 'Educação', 'educação': 'Educação', 'curso': 'Educação',
      'cuidados pessoais': 'Cuidados pessoais', 'beleza': 'Cuidados pessoais',
      'lazer': 'Lazer e Entretenimento', 'entretenimento': 'Lazer e Entretenimento', 'lazer e entretenimento': 'Lazer e Entretenimento',
      'vestuario': 'Vestuário', 'vestuário': 'Vestuário', 'roupa': 'Vestuário', 'roupas': 'Vestuário',
      'pets': 'Pets', 'pet': 'Pets',
      'casa': 'Casa', 'aluguel': 'Casa', 'condominio': 'Casa', 'luz': 'Casa', 'agua': 'Casa',
      'doacoes': 'Doações', 'doações': 'Doações',
      'impostos': 'Impostos', 'taxa': 'Impostos',
      'outros': 'Outros',
    };
    const chave = texto.toLowerCase().trim();
    return mapa[chave] || texto.charAt(0).toUpperCase() + texto.slice(1).toLowerCase();
  }

  // ── Define ou atualiza um limite no banco ─────────────────────────────────
  async _definirLimite(remoteJid, usuarioId, categoria, periodo, valor) {
    await db.query(
      `INSERT INTO limites_gastos (usuario_id, categoria, periodo, valor_limite, atualizado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (usuario_id, categoria, periodo)
       DO UPDATE SET valor_limite = $4, ativo = TRUE, atualizado_em = NOW()`,
      [usuarioId, categoria, periodo, valor]
    );

    const catLabel = categoria
      ? `${EMOJI_CATEGORIA[categoria] || '📂'} *${categoria}*`
      : '🌐 *global* (todas as categorias)';
    const periodoLabel = periodo === 'semanal' ? 'semana' : 'mês';

    // Calcula quanto já foi gasto para dar contexto imediato
    const jaGasto = periodo === 'semanal'
      ? await this._gastosSemana(usuarioId, 0)
      : await this._gastosMesAtual(usuarioId, categoria);

    const percentual = jaGasto > 0 ? Math.round((jaGasto / valor) * 100) : 0;
    const barra = this._barraProgresso(jaGasto, valor);

    let msg = `✅ *Limite configurado!*\n\n`;
    msg += `📂 Categoria: ${catLabel}\n`;
    msg += `📅 Período: ${periodoLabel}\n`;
    msg += `💰 Limite: *${fmt(valor)}*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *Situação atual deste ${periodoLabel}:*\n`;
    msg += `${barra}\n`;
    msg += `Gasto: *${fmt(jaGasto)}* de *${fmt(valor)}* (${percentual}%)\n\n`;

    if (percentual >= 100)
      msg += `⚠️ Atenção: você já ultrapassou esse limite!\n\n`;
    else if (percentual >= 80)
      msg += `🟡 Você já usou ${percentual}% do limite. Cuidado!\n\n`;

    msg += `📋 Ver todos os limites: _"limites"_\n`;
    msg += `🗑️ Remover: _"remover limite ${categoria || 'global'}"_`;

    await this.bot.enviar(remoteJid, msg);
  }

  // ── Remove um limite ──────────────────────────────────────────────────────
  async _removerLimite(remoteJid, usuarioId, alvo) {
    let categoria = null;
    const PALAVRAS_GLOBAL = ['global', 'total', 'geral', 'todos', 'tudo', ''];
    if (!PALAVRAS_GLOBAL.includes(alvo.toLowerCase()))
      categoria = this._normalizarCategoria(alvo);

    const res = await db.query(
      `DELETE FROM limites_gastos
       WHERE usuario_id = $1 AND (categoria = $2 OR ($2::TEXT IS NULL AND categoria IS NULL))
       RETURNING id`,
      [usuarioId, categoria]
    );

    if (res.rows.length === 0) {
      const catLabel = categoria ? `*${categoria}*` : '*global*';
      return this.bot.enviar(remoteJid,
        `❓ Não encontrei nenhum limite configurado para ${catLabel}.\n\n` +
        `Digite _"limites"_ para ver seus limites ativos.`
      );
    }

    const catLabel = categoria ? `*${categoria}*` : '*global*';
    await this.bot.enviar(remoteJid,
      `🗑️ Limite ${catLabel} removido com sucesso!\n\n` +
      `Digite _"limites"_ para ver seus limites ativos.`
    );
  }

  // ── Envia o menu/resumo de limites do usuário ─────────────────────────────
  async _enviarMenuLimites(remoteJid, usuarioId, nome) {
    const { rows: limites } = await db.query(
      `SELECT categoria, periodo, valor_limite
       FROM limites_gastos
       WHERE usuario_id = $1 AND ativo = TRUE
       ORDER BY periodo, categoria NULLS FIRST`,
      [usuarioId]
    );

    if (limites.length === 0) {
      let msg = `📊 *Limites de Gastos — ${nome}*\n\n`;
      msg += `Você ainda não tem nenhum limite configurado.\n\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💡 *Como definir um limite:*\n\n`;
      msg += `_"limite mensal 2000"_ — global por mês\n`;
      msg += `_"limite semanal 500"_ — global por semana\n`;
      msg += `_"limite alimentação 600"_ — por categoria\n`;
      msg += `_"limite semanal transporte 200"_ — semanal por categoria\n\n`;
      msg += `Ou fale naturalmente:\n`;
      msg += `_"quero gastar no máximo 1500 por mês"_`;
      return this.bot.enviar(remoteJid, msg);
    }

    let msg = `📊 *Seus Limites de Gastos*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const lim of limites) {
      const catLabel = lim.categoria
        ? `${EMOJI_CATEGORIA[lim.categoria] || '📂'} ${lim.categoria}`
        : '🌐 Global';
      const periodoLabel = lim.periodo === 'semanal' ? 'semana' : 'mês';

      const jaGasto = lim.periodo === 'semanal'
        ? await this._gastosSemana(usuarioId, 0)
        : await this._gastosMesAtual(usuarioId, lim.categoria);

      const percentual = Math.min(Math.round((jaGasto / lim.valor_limite) * 100), 999);
      const barra = this._barraProgresso(jaGasto, lim.valor_limite);

      let status = percentual >= 100 ? '🔴' : percentual >= 80 ? '🟡' : '🟢';

      msg += `${status} *${catLabel}* (${periodoLabel})\n`;
      msg += `${barra}\n`;
      msg += `   ${fmt(jaGasto)} / ${fmt(lim.valor_limite)} — ${percentual}%\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `➕ Adicionar: _"limite [categoria] [valor]"_\n`;
    msg += `🗑️ Remover: _"remover limite [categoria]"_`;

    await this.bot.enviar(remoteJid, msg);
  }

  // ── Barra de progresso visual ─────────────────────────────────────────────
  _barraProgresso(atual, limite) {
    const pct = Math.min(atual / limite, 1);
    const total = 10;
    const preenchido = Math.round(pct * total);
    const vazio = total - preenchido;
    const cor = pct >= 1 ? '🟥' : pct >= 0.8 ? '🟨' : '🟩';
    return cor.repeat(preenchido) + '⬜'.repeat(vazio);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FUNÇÃO 2 — ALERTAS AUTOMÁTICOS (rodado pelo setInterval a cada hora)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Verificação principal de alertas. Roda periodicamente.
   * Emite 3 tipos de alerta:
   *   A) Limite de gasto atingindo 80% (aviso)
   *   B) Limite de gasto ultrapassado 100% (crítico)
   *   C) Gasto semanal muito acima da semana passada (comparativo)
   */
  async verificarAlertasAutomaticos() {
    if (!this.bot.conectado || !this.bot.socket) return;
    await this._garantirTabelas();

    try {
      // Busca todos os usuários com sessão ativa
      const { rows: usuarios } = await db.query(
        `SELECT DISTINCT s.usuario_id, u.nome, s.telefone
         FROM sessoes_bot s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.telefone IS NOT NULL`
      );

      for (const usuario of usuarios) {
        try {
          await this._verificarAlertasUsuario(usuario);
        } catch (err) {
          console.error(`Erro ao verificar alertas para ${usuario.usuario_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Erro em verificarAlertasAutomaticos:', err.message);
    }
  }

  async _verificarAlertasUsuario(usuario) {
    const { usuario_id: usuarioId, nome, telefone } = usuario;
    const jid = `55${telefone}@s.whatsapp.net`;
    const primeiroNome = nome.split(' ')[0];

    // ── A e B: Alertas de limites configurados ───────────────────────────────
    const { rows: limites } = await db.query(
      `SELECT categoria, periodo, valor_limite
       FROM limites_gastos
       WHERE usuario_id = $1 AND ativo = TRUE`,
      [usuarioId]
    );

    for (const lim of limites) {
      const jaGasto = lim.periodo === 'semanal'
        ? await this._gastosSemana(usuarioId, 0)
        : await this._gastosMesAtual(usuarioId, lim.categoria);

      const percentual = jaGasto / parseFloat(lim.valor_limite);
      const periodoRef = lim.periodo === 'semanal' ? this._semanaLabel(0) : this._mesLabel();
      const catKey = lim.categoria || 'global';

      // Alerta 100% (ultrapassou)
      if (percentual >= THRESHOLD_CRITICO) {
        const refAlerta = `${periodoRef}-${catKey}-100`;
        if (!(await this._alertaJaEnviado(usuarioId, 'limite_100', refAlerta))) {
          await this._enviarAlerteLimite(jid, primeiroNome, lim, jaGasto, percentual, 'critico');
          await this._marcarAlertaEnviado(usuarioId, 'limite_100', refAlerta);
        }
      }
      // Alerta 80% (somente se ainda não ultrapassou)
      else if (percentual >= THRESHOLD_AVISO) {
        const refAlerta = `${periodoRef}-${catKey}-80`;
        if (!(await this._alertaJaEnviado(usuarioId, 'limite_80', refAlerta))) {
          await this._enviarAlerteLimite(jid, primeiroNome, lim, jaGasto, percentual, 'aviso');
          await this._marcarAlertaEnviado(usuarioId, 'limite_80', refAlerta);
        }
      }
    }

    // ── C: Alerta comparativo semanal (segunda-feira pela manhã) ─────────────
    // Só envia na segunda-feira, entre 8h e 11h (BRT)
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const diaSemana = agora.getDay(); // 0=dom, 1=seg...
    const hora = agora.getHours();

    if (diaSemana === 1 && hora >= 8 && hora < 11) {
      const semanaAtual = this._semanaLabel(0);
      const refAlerta = `${semanaAtual}-comparativo`;

      if (!(await this._alertaJaEnviado(usuarioId, 'comparativo_semanal', refAlerta))) {
        await this._verificarAlertaComparativoSemanal(jid, usuarioId, primeiroNome);
        await this._marcarAlertaEnviado(usuarioId, 'comparativo_semanal', refAlerta);
      }
    }
  }

  // ── Formata e envia o alerta de limite ────────────────────────────────────
  async _enviarAlerteLimite(jid, nome, lim, jaGasto, percentual, nivel) {
    const catLabel = lim.categoria
      ? `${EMOJI_CATEGORIA[lim.categoria] || '📂'} *${lim.categoria}*`
      : '🌐 *todos os gastos*';
    const periodoLabel = lim.periodo === 'semanal' ? 'semana' : 'mês';
    const pct = Math.round(percentual * 100);
    const barra = this._barraProgresso(jaGasto, lim.valor_limite);

    let msg;
    if (nivel === 'critico') {
      msg =
        `🚨 *Atenção, ${nome}! Limite ultrapassado!*\n\n` +
        `Você ultrapassou o limite de ${catLabel} neste ${periodoLabel}.\n\n` +
        `${barra}\n` +
        `💸 Gasto: *${fmt(jaGasto)}*\n` +
        `🚫 Limite: *${fmt(lim.valor_limite)}*\n` +
        `📈 Uso: *${pct}%*\n\n` +
        `Hora de apertar o freio! 🛑\n\n` +
        `📊 Digite *resumo* para ver o detalhamento completo.`;
    } else {
      msg =
        `⚠️ *${nome}, você está chegando no limite!*\n\n` +
        `Já usou *${pct}%* do limite de ${catLabel} neste ${periodoLabel}.\n\n` +
        `${barra}\n` +
        `💸 Gasto até agora: *${fmt(jaGasto)}*\n` +
        `💰 Limite configurado: *${fmt(lim.valor_limite)}*\n` +
        `🔋 Restam: *${fmt(parseFloat(lim.valor_limite) - jaGasto)}*\n\n` +
        `Vá com calma nos próximos dias! 😊\n\n` +
        `📊 Digite *resumo* para ver o detalhamento completo.`;
    }

    await this.bot.enviar(jid, msg);
    console.log(`🔔 Alerta de limite (${nivel}) enviado para ${jid}`);
  }

  // ── Alerta comparativo semanal ────────────────────────────────────────────
  async _verificarAlertaComparativoSemanal(jid, usuarioId, nome) {
    const totalAtual    = await this._gastosSemana(usuarioId, 0);  // semana passada (segunda = semana anterior completa)
    const totalAnterior = await this._gastosSemana(usuarioId, -1); // 2 semanas atrás

    // Sem dados suficientes, pula
    if (totalAnterior === 0 || totalAtual === 0) return;

    const diferenca = totalAtual - totalAnterior;
    const percentualDiff = Math.abs(diferenca) / totalAnterior;

    // Só envia alerta se a diferença for maior que 20%
    if (percentualDiff < 0.20) return;

    const categorias = await this._gastosPorCategoriaSemana(usuarioId, 0);
    const catAnterior = await this._gastosPorCategoriaSemana(usuarioId, -1);

    // Calcula diferença por categoria
    const mapAnterior = Object.fromEntries(catAnterior.map(r => [r.categoria, parseFloat(r.total)]));
    const destaques = categorias
      .map(r => ({
        categoria: r.categoria,
        atual: parseFloat(r.total),
        anterior: mapAnterior[r.categoria] || 0,
        diff: parseFloat(r.total) - (mapAnterior[r.categoria] || 0),
      }))
      .filter(r => r.diff > 0 && r.diff > 30) // somente categorias com aumento relevante
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 3);

    const sinal = diferenca > 0 ? '📈' : '📉';
    const verbo = diferenca > 0 ? 'mais' : 'menos';
    const emoji = diferenca > 0 ? '😬' : '🎉';

    let msg = `${sinal} *Resumo semanal, ${nome}!*\n\n`;

    if (diferenca > 0) {
      msg += `Você gastou *${fmt(Math.abs(diferenca))} a mais* esta semana comparado à semana passada. ${emoji}\n\n`;
    } else {
      msg += `Ótima semana! Você gastou *${fmt(Math.abs(diferenca))} a menos* do que na semana passada. ${emoji}\n\n`;
    }

    msg += `📅 Semana passada: *${fmt(totalAnterior)}*\n`;
    msg += `📅 Esta semana: *${fmt(totalAtual)}*\n\n`;

    if (destaques.length > 0 && diferenca > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `🔍 *Onde gastou mais:*\n\n`;
      for (const d of destaques) {
        const emojCat = EMOJI_CATEGORIA[d.categoria] || '📦';
        msg += `${emojCat} *${d.categoria}*: +${fmt(d.diff)}\n`;
        msg += `   (${fmt(d.anterior)} → ${fmt(d.atual)})\n\n`;
      }
    }

    if (diferenca > 0) {
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💡 Vá com calma essa semana! Cada real economizado conta. 😊\n\n`;
    }

    msg += `📊 Digite *resumo* para o relatório completo do mês.`;

    await this.bot.enviar(jid, msg);
    console.log(`📊 Alerta comparativo semanal enviado para ${jid}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FUNÇÃO 3 — Alerta em tempo real após registrar uma transação
  // Chame esta função em registrarTransacao() e registrarTransacaoSilencioso()
  // logo após inserir a transação no banco:
  //   await this._limitesAlertas.verificarLimiteAposTransacao(remoteJid, usuarioId, transacao);
  // ══════════════════════════════════════════════════════════════════════════

  async verificarLimiteAposTransacao(remoteJid, usuarioId, transacao) {
    if (transacao.tipo !== 'despesa') return;
    await this._garantirTabelas();

    // Busca limites que se aplicam a esta categoria (e limite global)
    const { rows: limites } = await db.query(
      `SELECT categoria, periodo, valor_limite
       FROM limites_gastos
       WHERE usuario_id = $1
         AND ativo = TRUE
         AND (categoria IS NULL OR LOWER(categoria) = LOWER($2))`,
      [usuarioId, transacao.categoria]
    );

    for (const lim of limites) {
      const jaGasto = lim.periodo === 'semanal'
        ? await this._gastosSemana(usuarioId, 0)
        : await this._gastosMesAtual(usuarioId, lim.categoria);

      const percentual = jaGasto / parseFloat(lim.valor_limite);
      const periodoRef = lim.periodo === 'semanal' ? this._semanaLabel(0) : this._mesLabel();
      const catKey = lim.categoria || 'global';

      if (percentual >= THRESHOLD_CRITICO) {
        const refAlerta = `${periodoRef}-${catKey}-100`;
        if (!(await this._alertaJaEnviado(usuarioId, 'limite_100', refAlerta))) {
          const catLabel = lim.categoria
            ? `${EMOJI_CATEGORIA[lim.categoria] || '📂'} *${lim.categoria}*`
            : '🌐 *total mensal*';
          const periodoLabel = lim.periodo === 'semanal' ? 'semana' : 'mês';
          const barra = this._barraProgresso(jaGasto, lim.valor_limite);
          const pct = Math.round(percentual * 100);

          const msg =
            `🚨 *Limite ultrapassado!*\n\n` +
            `Com esse gasto, você passou o limite de ${catLabel} neste ${periodoLabel}.\n\n` +
            `${barra}\n` +
            `💸 Total gasto: *${fmt(jaGasto)}*\n` +
            `🚫 Limite: *${fmt(lim.valor_limite)}* (${pct}% usado)\n\n` +
            `Hora de dar um freio! 🛑`;

          await this.bot.enviar(remoteJid, msg);
          await this._marcarAlertaEnviado(usuarioId, 'limite_100', refAlerta);
        }
      } else if (percentual >= THRESHOLD_AVISO) {
        const refAlerta = `${periodoRef}-${catKey}-80`;
        if (!(await this._alertaJaEnviado(usuarioId, 'limite_80', refAlerta))) {
          const catLabel = lim.categoria
            ? `${EMOJI_CATEGORIA[lim.categoria] || '📂'} *${lim.categoria}*`
            : '🌐 *total mensal*';
          const periodoLabel = lim.periodo === 'semanal' ? 'semana' : 'mês';
          const barra = this._barraProgresso(jaGasto, lim.valor_limite);
          const pct = Math.round(percentual * 100);
          const restam = parseFloat(lim.valor_limite) - jaGasto;

          const msg =
            `⚠️ *Atenção ao limite de ${catLabel}!*\n\n` +
            `Você já usou *${pct}%* do limite neste ${periodoLabel}.\n\n` +
            `${barra}\n` +
            `💸 Gasto: *${fmt(jaGasto)}* / ${fmt(lim.valor_limite)}\n` +
            `🔋 Restam: *${fmt(restam)}*\n\n` +
            `Vá com calma! 😊`;

          await this.bot.enviar(remoteJid, msg);
          await this._marcarAlertaEnviado(usuarioId, 'limite_80', refAlerta);
        }
      }
    }
  }
}

module.exports = { LimitesAlertas };
