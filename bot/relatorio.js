// bot/relatorio.js — Gerador de Relatório PDF para o Seu Bolso
// Requer: npm install reportlab  →  na verdade usa: pip install reportlab
// Chamado via: node -e "..." ou gerado via script Python separado
// Este módulo gera o PDF usando Python (reportlab) via child_process

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');

const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const EMOJI_CATEGORIA = {
  'Alimentação': '🍔', 'Saúde': '🏥', 'Assinatura': '📱',
  'Transporte': '🚗', 'Viagem': '✈️', 'Doações': '🤝',
  'Impostos': '🧾', 'Mercado': '🛒', 'Educação': '📚',
  'Cuidados pessoais': '💅', 'Lazer e Entretenimento': '🎉',
  'Vestuário': '👗', 'Pets': '🐾', 'Casa': '🏠',
  'Salário': '💰', 'Freelance': '💼', 'Outros': '📦',
  'Investimentos': '📈', 'Lazer': '🎯',
};

const MESES = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
];

/**
 * Coleta todos os dados do mês para o relatório
 */
async function coletarDadosRelatorio(usuarioId, mes, ano) {
  // Totais gerais
  const { rows: totais } = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN tipo='receita' AND pago=true THEN valor END), 0) AS recebido,
      COALESCE(SUM(CASE WHEN tipo='receita' AND pago=false THEN valor END), 0) AS a_receber,
      COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=true THEN valor END), 0) AS pago,
      COALESCE(SUM(CASE WHEN tipo='despesa' AND pago=false THEN valor END), 0) AS a_pagar
    FROM transacoes
    WHERE usuario_id = $1
      AND EXTRACT(MONTH FROM COALESCE(data_pagamento, data_vencimento)) = $2
      AND EXTRACT(YEAR FROM COALESCE(data_pagamento, data_vencimento)) = $3
  `, [usuarioId, mes, ano]);

  // Despesas por categoria
  const { rows: catDespesas } = await db.query(`
    SELECT
      COALESCE(c.nome, 'Outros') AS categoria,
      SUM(t.valor) AS total,
      COUNT(*) AS qtd
    FROM transacoes t
    LEFT JOIN categorias c ON c.id = t.categoria_id
    WHERE t.usuario_id = $1
      AND t.tipo = 'despesa'
      AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
      AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
    GROUP BY c.nome
    ORDER BY total DESC
  `, [usuarioId, mes, ano]);

  // Receitas por categoria
  const { rows: catReceitas } = await db.query(`
    SELECT
      COALESCE(c.nome, 'Outros') AS categoria,
      SUM(t.valor) AS total,
      COUNT(*) AS qtd
    FROM transacoes t
    LEFT JOIN categorias c ON c.id = t.categoria_id
    WHERE t.usuario_id = $1
      AND t.tipo = 'receita'
      AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
      AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
    GROUP BY c.nome
    ORDER BY total DESC
  `, [usuarioId, mes, ano]);

  // Todas as transações do mês (listagem completa)
  const { rows: transacoes } = await db.query(`
    SELECT
      t.id_curto,
      t.tipo,
      t.descricao,
      t.valor,
      t.pago,
      COALESCE(c.nome, 'Outros') AS categoria,
      COALESCE(t.data_pagamento, t.data_vencimento) AS data
    FROM transacoes t
    LEFT JOIN categorias c ON c.id = t.categoria_id
    WHERE t.usuario_id = $1
      AND EXTRACT(MONTH FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $2
      AND EXTRACT(YEAR FROM COALESCE(t.data_pagamento, t.data_vencimento)) = $3
    ORDER BY COALESCE(t.data_pagamento, t.data_vencimento) ASC, t.criado_em ASC
  `, [usuarioId, mes, ano]);

  // Dados do usuário
  const { rows: usuario } = await db.query(
    `SELECT nome FROM usuarios WHERE id = $1`, [usuarioId]
  );

  return {
    usuario: usuario[0]?.nome || 'Usuário',
    mes,
    ano,
    nomeMes: MESES[mes - 1],
    totais: totais[0],
    catDespesas,
    catReceitas,
    transacoes,
  };
}

/**
 * Gera o script Python para criar o PDF
 */
function gerarScriptPython(dados, outputPath) {
  const fmt = (v) => `R$ ${parseFloat(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const recebido   = parseFloat(dados.totais.recebido);
  const aReceber   = parseFloat(dados.totais.a_receber);
  const pago       = parseFloat(dados.totais.pago);
  const aPagar     = parseFloat(dados.totais.a_pagar);
  const saldo      = recebido - pago;
  const saldoPrev  = (recebido + aReceber) - (pago + aPagar);
  const totalDesp  = pago + aPagar;

  // Serializa dados para o script Python (JSON embutido)
  const dadosPython = JSON.stringify({
    usuario: dados.usuario,
    mes: dados.nomeMes,
    ano: dados.ano,
    recebido, aReceber, pago, aPagar, saldo, saldoPrev, totalDesp,
    catDespesas: dados.catDespesas.map(r => ({
      categoria: r.categoria,
      total: parseFloat(r.total),
      qtd: parseInt(r.qtd),
    })),
    catReceitas: dados.catReceitas.map(r => ({
      categoria: r.categoria,
      total: parseFloat(r.total),
      qtd: parseInt(r.qtd),
    })),
    transacoes: dados.transacoes.map(t => ({
      id_curto: t.id_curto || '—',
      tipo: t.tipo,
      descricao: t.descricao,
      valor: parseFloat(t.valor),
      pago: t.pago,
      categoria: t.categoria,
      data: t.data ? new Date(t.data).toLocaleDateString('pt-BR') : '—',
    })),
    gerado_em: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  });

  // Escapar aspas para o heredoc Python
  const dadosEscapados = dadosPython.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

# ── Dados ──────────────────────────────────────────────────────
dados = json.loads('${dadosEscapados}')

def fmt_brl(valor):
    s = f"{abs(valor):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {s}"

def pct(parte, total):
    if total == 0: return "0,0%"
    return f"{(parte/total*100):.1f}%"

# ── Cores ──────────────────────────────────────────────────────
COR_VERDE       = colors.HexColor('#00C48C')
COR_VERDE_DARK  = colors.HexColor('#00A878')
COR_VERMELHO    = colors.HexColor('#FF5252')
COR_AZUL        = colors.HexColor('#1565C0')
COR_CINZA_DARK  = colors.HexColor('#2D2D2D')
COR_CINZA_MED   = colors.HexColor('#666666')
COR_CINZA_LIGHT = colors.HexColor('#F5F5F5')
COR_CINZA_BORDA = colors.HexColor('#E0E0E0')
COR_AMARELO     = colors.HexColor('#FFC107')
COR_HEADER_BG   = colors.HexColor('#1A1A2E')
COR_HEADER_TXT  = colors.white
COR_RECEITA_BG  = colors.HexColor('#E8F5E9')
COR_DESPESA_BG  = colors.HexColor('#FFEBEE')

# ── Documento ──────────────────────────────────────────────────
doc = SimpleDocTemplate(
    '${outputPath}',
    pagesize=A4,
    rightMargin=15*mm, leftMargin=15*mm,
    topMargin=15*mm, bottomMargin=20*mm,
    title=f"Relatório Financeiro - {dados['mes']}/{dados['ano']}",
    author="Seu Bolso",
)

W, H = A4
largura_util = W - 30*mm

styles = getSampleStyleSheet()

def estilo(nome, **kw):
    base = styles.get(nome, styles['Normal'])
    return ParagraphStyle(
        name=f"custom_{id(kw)}",
        parent=base,
        **kw
    )

story = []

# ═══════════════════════════════════════════════════════════════
# CABEÇALHO PRINCIPAL
# ═══════════════════════════════════════════════════════════════
header_data = [[
    Paragraph(
        f'<font color="white"><b>📊 RELATÓRIO FINANCEIRO</b></font>',
        estilo('Normal', fontSize=16, textColor=colors.white, alignment=TA_CENTER)
    ),
    Paragraph(
        f'<font color="white"><b>{dados["mes"].upper()} / {dados["ano"]}</b></font>',
        estilo('Normal', fontSize=14, textColor=COR_AMARELO, alignment=TA_CENTER)
    ),
]]
header_table = Table([[
    Paragraph(
        f'SEU BOLSO  |  Relatório de {dados["mes"]}/{dados["ano"]}',
        estilo('Normal', fontSize=18, textColor=colors.white,
               alignment=TA_CENTER, fontName='Helvetica-Bold')
    )
]], colWidths=[largura_util])
header_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,-1), COR_HEADER_BG),
    ('TEXTCOLOR', (0,0), (-1,-1), colors.white),
    ('ALIGN', (0,0), (-1,-1), 'CENTER'),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 14),
    ('BOTTOMPADDING', (0,0), (-1,-1), 14),
    ('ROUNDEDCORNERS', [6,6,6,6]),
]))
story.append(header_table)
story.append(Spacer(1, 4*mm))

# Sub-cabeçalho com usuário e data de geração
sub = Table([[
    Paragraph(
        f'👤 {dados["usuario"]}',
        estilo('Normal', fontSize=10, textColor=COR_CINZA_MED)
    ),
    Paragraph(
        f'🗓️ Gerado em {dados["gerado_em"]}',
        estilo('Normal', fontSize=10, textColor=COR_CINZA_MED, alignment=TA_RIGHT)
    ),
]], colWidths=[largura_util/2, largura_util/2])
sub.setStyle(TableStyle([
    ('ALIGN', (0,0), (0,0), 'LEFT'),
    ('ALIGN', (1,0), (1,0), 'RIGHT'),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('BOTTOMPADDING', (0,0), (-1,-1), 2),
]))
story.append(sub)
story.append(HRFlowable(width=largura_util, thickness=1, color=COR_CINZA_BORDA))
story.append(Spacer(1, 5*mm))

# ═══════════════════════════════════════════════════════════════
# CARDS DE RESUMO (4 cards na mesma linha)
# ═══════════════════════════════════════════════════════════════
def card(titulo, valor, cor_bg, cor_valor, subtitulo=''):
    return [
        Paragraph(titulo, estilo('Normal', fontSize=8, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
        Spacer(1, 2),
        Paragraph(
            f'<b>{valor}</b>',
            estilo('Normal', fontSize=12, textColor=cor_valor, alignment=TA_CENTER, fontName='Helvetica-Bold')
        ),
        Paragraph(subtitulo, estilo('Normal', fontSize=7, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
    ]

saldo_cor = COR_VERDE if dados['saldo'] >= 0 else COR_VERMELHO
saldo_icon = '📈' if dados['saldo'] >= 0 else '📉'

w = largura_util / 4 - 2*mm
cards_data = [[
    card('💰 SALDO ATUAL', fmt_brl(dados['saldo']), COR_RECEITA_BG, saldo_cor,
         f'{saldo_icon} disponível'),
    card('📥 RECEITAS', fmt_brl(dados['recebido']), COR_RECEITA_BG, COR_VERDE,
         f'+ {fmt_brl(dados["aReceber"])} a receber'),
    card('📤 DESPESAS', fmt_brl(dados['pago']), COR_DESPESA_BG, COR_VERMELHO,
         f'+ {fmt_brl(dados["aPagar"])} a pagar'),
    card('🔮 SALDO PREVISTO', fmt_brl(dados['saldoPrev']), COR_CINZA_LIGHT, COR_AZUL,
         'receitas - despesas'),
]]
cards_table = Table(cards_data, colWidths=[w, w, w, w])
cards_table.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (0,0), COR_RECEITA_BG),
    ('BACKGROUND', (1,0), (1,0), COR_RECEITA_BG),
    ('BACKGROUND', (2,0), (2,0), COR_DESPESA_BG),
    ('BACKGROUND', (3,0), (3,0), COR_CINZA_LIGHT),
    ('BOX', (0,0), (0,0), 1, COR_VERDE),
    ('BOX', (1,0), (1,0), 1, COR_VERDE),
    ('BOX', (2,0), (2,0), 1, COR_VERMELHO),
    ('BOX', (3,0), (3,0), 1, COR_CINZA_BORDA),
    ('ALIGN', (0,0), (-1,-1), 'CENTER'),
    ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 8),
    ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ('LEFTPADDING', (0,0), (-1,-1), 4),
    ('RIGHTPADDING', (0,0), (-1,-1), 4),
    ('ROUNDEDCORNERS', [4,4,4,4]),
]))
story.append(cards_table)
story.append(Spacer(1, 6*mm))

# ═══════════════════════════════════════════════════════════════
# DESPESAS POR CATEGORIA (barra de progresso visual)
# ═══════════════════════════════════════════════════════════════
if dados['catDespesas']:
    story.append(Paragraph(
        '📊 DESPESAS POR CATEGORIA',
        estilo('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=COR_CINZA_DARK)
    ))
    story.append(Spacer(1, 3*mm))

    total_desp = dados['totalDesp']
    cat_rows = [
        [
            Paragraph('<b>Categoria</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED)),
            Paragraph('<b>Qtd</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
            Paragraph('<b>Valor</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
            Paragraph('<b>%</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
        ]
    ]
    for i, cat in enumerate(dados['catDespesas']):
        bg = COR_CINZA_LIGHT if i % 2 == 0 else colors.white
        cat_rows.append([
            Paragraph(f'{cat["categoria"]}', estilo('Normal', fontSize=9, textColor=COR_CINZA_DARK)),
            Paragraph(str(cat['qtd']), estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
            Paragraph(f'<b>{fmt_brl(cat["total"])}</b>', estilo('Normal', fontSize=9, textColor=COR_VERMELHO, alignment=TA_RIGHT)),
            Paragraph(pct(cat['total'], total_desp), estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
        ])

    col_w = [largura_util*0.5, largura_util*0.1, largura_util*0.25, largura_util*0.15]
    cat_table = Table(cat_rows, colWidths=col_w)
    row_styles = [
        ('BACKGROUND', (0,0), (-1,0), COR_HEADER_BG),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('ALIGN', (1,0), (1,-1), 'CENTER'),
        ('ALIGN', (2,0), (3,-1), 'RIGHT'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('GRID', (0,0), (-1,-1), 0.5, COR_CINZA_BORDA),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [COR_CINZA_LIGHT, colors.white]),
    ]
    cat_table.setStyle(TableStyle(row_styles))
    story.append(cat_table)
    story.append(Spacer(1, 6*mm))

# ═══════════════════════════════════════════════════════════════
# RECEITAS POR CATEGORIA
# ═══════════════════════════════════════════════════════════════
if dados['catReceitas']:
    story.append(Paragraph(
        '💰 RECEITAS POR CATEGORIA',
        estilo('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=COR_CINZA_DARK)
    ))
    story.append(Spacer(1, 3*mm))

    total_rec = dados['recebido'] + dados['aReceber']
    rec_rows = [
        [
            Paragraph('<b>Categoria</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED)),
            Paragraph('<b>Qtd</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
            Paragraph('<b>Valor</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
            Paragraph('<b>%</b>', estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
        ]
    ]
    for i, cat in enumerate(dados['catReceitas']):
        rec_rows.append([
            Paragraph(cat['categoria'], estilo('Normal', fontSize=9, textColor=COR_CINZA_DARK)),
            Paragraph(str(cat['qtd']), estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
            Paragraph(f'<b>{fmt_brl(cat["total"])}</b>', estilo('Normal', fontSize=9, textColor=COR_VERDE_DARK, alignment=TA_RIGHT)),
            Paragraph(pct(cat['total'], total_rec), estilo('Normal', fontSize=9, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
        ])

    col_w = [largura_util*0.5, largura_util*0.1, largura_util*0.25, largura_util*0.15]
    rec_table = Table(rec_rows, colWidths=col_w)
    rec_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), COR_VERDE_DARK),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('ALIGN', (1,0), (1,-1), 'CENTER'),
        ('ALIGN', (2,0), (3,-1), 'RIGHT'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('GRID', (0,0), (-1,-1), 0.5, COR_CINZA_BORDA),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [COR_RECEITA_BG, colors.white]),
    ]))
    story.append(rec_table)
    story.append(Spacer(1, 6*mm))

# ═══════════════════════════════════════════════════════════════
# LISTAGEM COMPLETA DE TRANSAÇÕES
# ═══════════════════════════════════════════════════════════════
if dados['transacoes']:
    story.append(PageBreak())
    story.append(Paragraph(
        f'📋 TODAS AS TRANSAÇÕES — {dados["mes"].upper()}/{dados["ano"]}',
        estilo('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=COR_CINZA_DARK)
    ))
    story.append(Spacer(1, 3*mm))

    tx_rows = [[
        Paragraph('<b>Data</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED)),
        Paragraph('<b>ID</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
        Paragraph('<b>Descrição</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED)),
        Paragraph('<b>Categoria</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED)),
        Paragraph('<b>Tipo</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED, alignment=TA_CENTER)),
        Paragraph('<b>Valor</b>', estilo('Normal', fontSize=8, textColor=COR_CINZA_MED, alignment=TA_RIGHT)),
    ]]

    table_style = [
        ('BACKGROUND', (0,0), (-1,0), COR_HEADER_BG),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 8),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('GRID', (0,0), (-1,-1), 0.3, COR_CINZA_BORDA),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('ALIGN', (1,0), (1,-1), 'CENTER'),
        ('ALIGN', (4,0), (4,-1), 'CENTER'),
        ('ALIGN', (5,0), (5,-1), 'RIGHT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]

    for i, tx in enumerate(dados['transacoes']):
        is_receita = tx['tipo'] == 'receita'
        cor_valor = COR_VERDE_DARK if is_receita else COR_VERMELHO
        tipo_label = '📥 Receita' if is_receita else '📤 Despesa'
        row_bg = COR_RECEITA_BG if is_receita else (COR_CINZA_LIGHT if i % 2 == 0 else colors.white)

        tx_rows.append([
            Paragraph(tx['data'], estilo('Normal', fontSize=8)),
            Paragraph(tx['id_curto'], estilo('Normal', fontSize=8, alignment=TA_CENTER, textColor=COR_CINZA_MED)),
            Paragraph(tx['descricao'][:35], estilo('Normal', fontSize=8)),
            Paragraph(tx['categoria'][:18], estilo('Normal', fontSize=8, textColor=COR_CINZA_MED)),
            Paragraph(tipo_label, estilo('Normal', fontSize=7, alignment=TA_CENTER)),
            Paragraph(
                f'<b>{fmt_brl(tx["valor"])}</b>',
                estilo('Normal', fontSize=8, textColor=cor_valor, alignment=TA_RIGHT)
            ),
        ])
        table_style.append(('BACKGROUND', (0, i+1), (-1, i+1), row_bg))

    col_w = [
        largura_util*0.10,  # data
        largura_util*0.07,  # id
        largura_util*0.30,  # descricao
        largura_util*0.20,  # categoria
        largura_util*0.13,  # tipo
        largura_util*0.20,  # valor
    ]
    tx_table = Table(tx_rows, colWidths=col_w, repeatRows=1)
    tx_table.setStyle(TableStyle(table_style))
    story.append(tx_table)
    story.append(Spacer(1, 5*mm))

# ═══════════════════════════════════════════════════════════════
# RODAPÉ
# ═══════════════════════════════════════════════════════════════
story.append(HRFlowable(width=largura_util, thickness=1, color=COR_CINZA_BORDA))
story.append(Spacer(1, 3*mm))
story.append(Paragraph(
    f'Gerado pelo Seu Bolso • {dados["gerado_em"]} • Acesse seu painel completo em seu painel web',
    estilo('Normal', fontSize=7, textColor=COR_CINZA_MED, alignment=TA_CENTER)
))

# ── Build ──────────────────────────────────────────────────────
doc.build(story)
print("PDF gerado com sucesso!")
`;
}

/**
 * Gera o PDF e retorna o caminho do arquivo
 */
async function gerarRelatorio(usuarioId, mes, ano) {
  const dados = await coletarDadosRelatorio(usuarioId, mes, ano);

  const nomeArquivo = `relatorio_${dados.nomeMes.toLowerCase()}_${ano}_${Date.now()}.pdf`;
  const outputPath = path.join(TMP_DIR, nomeArquivo);
  const scriptPath = path.join(TMP_DIR, `gen_pdf_${Date.now()}.py`);

  // Gera o script Python
  const script = gerarScriptPython(dados, outputPath);
  fs.writeFileSync(scriptPath, script, 'utf8');

  // Instala reportlab se não tiver
  try {
    execSync('pip install reportlab --break-system-packages -q', { timeout: 60000 });
  } catch (e) {
    console.warn('pip install reportlab falhou:', e.message);
  }

  // Executa o script Python
  const result = spawnSync('python3', [scriptPath], {
    encoding: 'utf8',
    timeout: 30000,
  });

  // Limpa o script temporário
  try { fs.unlinkSync(scriptPath); } catch {}

  if (result.status !== 0) {
    const erro = result.stderr || result.stdout || 'Erro desconhecido';
    console.error('Erro ao gerar PDF:', erro);
    throw new Error(`Falha ao gerar PDF: ${erro.slice(0, 200)}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error('PDF não foi criado');
  }

  return { outputPath, dados };
}

/**
 * Limpa arquivos PDF antigos do tmp (> 1 hora)
 */
function limparPdfsAntigos() {
  try {
    const agora = Date.now();
    const arquivos = fs.readdirSync(TMP_DIR);
    for (const arq of arquivos) {
      if (!arq.startsWith('relatorio_') || !arq.endsWith('.pdf')) continue;
      const caminho = path.join(TMP_DIR, arq);
      const stat = fs.statSync(caminho);
      if (agora - stat.mtimeMs > 3600000) {
        fs.unlinkSync(caminho);
      }
    }
  } catch {}
}

module.exports = { gerarRelatorio, coletarDadosRelatorio, limparPdfsAntigos };
