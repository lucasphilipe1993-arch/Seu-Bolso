-- ============================================================
--  GranaZen — Schema PostgreSQL
--  Execute este arquivo uma única vez para criar o banco
--  Railway: psql $DATABASE_URL -f database/schema.sql
-- ============================================================

-- Extensão para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────────────────────────
-- USUÁRIOS
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome                   VARCHAR(100) NOT NULL,
  email                  VARCHAR(150) UNIQUE NOT NULL,
  senha_hash             VARCHAR(255) NOT NULL,
  telefone               VARCHAR(30),          -- ex: 5511999998888 (formato Baileys)
  whatsapp_ativo         BOOLEAN DEFAULT FALSE,
  plano                  VARCHAR(20) DEFAULT 'gratuito', -- gratuito | pro | premium | zen
  stripe_customer_id     TEXT,                 -- ID do customer no Stripe (cus_...)
  stripe_subscription_id TEXT,                 -- ID da assinatura ativa (sub_...)
  criado_em              TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em          TIMESTAMPTZ DEFAULT NOW()
);

-- Adiciona colunas Stripe caso a tabela já exista (migração segura)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- ──────────────────────────────────────────────────────────
-- CATEGORIAS
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categorias (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  nome        VARCHAR(80) NOT NULL,
  tipo        VARCHAR(10) NOT NULL CHECK (tipo IN ('receita','despesa','ambos')),
  cor         VARCHAR(7) DEFAULT '#16a34a',
  icone       VARCHAR(50),
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- Categorias padrão (usuario_id NULL = globais)
INSERT INTO categorias (usuario_id, nome, tipo, cor) VALUES
  (NULL, 'Alimentação',    'despesa', '#ef4444'),
  (NULL, 'Transporte',     'despesa', '#f97316'),
  (NULL, 'Moradia',        'despesa', '#eab308'),
  (NULL, 'Saúde',          'despesa', '#06b6d4'),
  (NULL, 'Lazer',          'despesa', '#8b5cf6'),
  (NULL, 'Educação',       'despesa', '#ec4899'),
  (NULL, 'Roupas',         'despesa', '#f43f5e'),
  (NULL, 'Investimentos',  'despesa', '#10b981'),
  (NULL, 'Outros',         'ambos',   '#6b7280'),
  (NULL, 'Salário',        'receita', '#22c55e'),
  (NULL, 'Freelance',      'receita', '#16a34a'),
  (NULL, 'Presente',       'receita', '#84cc16')
ON CONFLICT DO NOTHING;

-- ──────────────────────────────────────────────────────────
-- CONTAS BANCÁRIAS
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id  UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  nome        VARCHAR(80) NOT NULL,       -- ex: Nubank, Bradesco
  tipo        VARCHAR(20) DEFAULT 'corrente',
  saldo       NUMERIC(14,2) DEFAULT 0,
  padrao      BOOLEAN DEFAULT FALSE,
  cor         VARCHAR(7) DEFAULT '#16a34a',
  criado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────
-- TRANSAÇÕES
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transacoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id      UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  conta_id        UUID REFERENCES contas(id) ON DELETE SET NULL,
  categoria_id    UUID REFERENCES categorias(id) ON DELETE SET NULL,
  tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('receita','despesa')),
  descricao       TEXT NOT NULL,
  valor           NUMERIC(14,2) NOT NULL,
  data_vencimento DATE,
  data_pagamento  DATE,
  pago            BOOLEAN DEFAULT FALSE,
  fixo            BOOLEAN DEFAULT FALSE,
  origem          VARCHAR(20) DEFAULT 'web', -- web | whatsapp
  mensagem_raw    TEXT,                       -- mensagem original do WhatsApp
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_transacoes_usuario   ON transacoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_transacoes_data      ON transacoes(data_vencimento);
CREATE INDEX IF NOT EXISTS idx_transacoes_categoria ON transacoes(categoria_id);

-- ──────────────────────────────────────────────────────────
-- LEMBRETES
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lembretes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  transacao_id  UUID REFERENCES transacoes(id) ON DELETE CASCADE,
  enviado       BOOLEAN DEFAULT FALSE,
  data_envio    TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────
-- SESSÕES WHATSAPP (estado da conversa)
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessoes_bot (
  telefone      VARCHAR(30) PRIMARY KEY,
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  estado        VARCHAR(50) DEFAULT 'idle',  -- idle | aguardando_valor | aguardando_categoria
  contexto      JSONB DEFAULT '{}',
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────
-- FUNÇÃO: atualiza campo atualizado_em automaticamente
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers (DROP IF EXISTS para ser idempotente)
DROP TRIGGER IF EXISTS tg_usuarios_atualizado ON usuarios;
CREATE TRIGGER tg_usuarios_atualizado
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION atualizar_timestamp();

DROP TRIGGER IF EXISTS tg_transacoes_atualizado ON transacoes;
CREATE TRIGGER tg_transacoes_atualizado
  BEFORE UPDATE ON transacoes
  FOR EACH ROW EXECUTE FUNCTION atualizar_timestamp();
