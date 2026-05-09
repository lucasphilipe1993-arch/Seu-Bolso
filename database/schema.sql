-- ============================================================
--  Seu Secretário — Schema PostgreSQL
--  Execute: psql $DATABASE_URL -f database/schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────────────────────────
-- USUÁRIOS
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome                   VARCHAR(100) NOT NULL,
  sobrenome              VARCHAR(100),
  email                  VARCHAR(150) UNIQUE NOT NULL,
  senha_hash             VARCHAR(255) NOT NULL,
  telefone               VARCHAR(30),
  whatsapp_ativo         BOOLEAN DEFAULT FALSE,
  plano                  VARCHAR(20) DEFAULT 'gratuito', -- gratuito | basico | premium

  -- ── Stripe ──────────────────────────────────────────────
  stripe_customer_id     VARCHAR(100) UNIQUE,
  stripe_subscription_id VARCHAR(100),

  criado_em              TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em          TIMESTAMPTZ DEFAULT NOW()
);

-- Índices úteis
CREATE INDEX IF NOT EXISTS idx_usuarios_stripe_customer      ON usuarios(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_stripe_subscription  ON usuarios(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email                ON usuarios(email);

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
  nome        VARCHAR(80) NOT NULL,
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
  origem          VARCHAR(20) DEFAULT 'web',
  mensagem_raw    TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
);

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
-- SESSÕES BOT
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessoes_bot (
  telefone      VARCHAR(30) PRIMARY KEY,
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  estado        VARCHAR(50) DEFAULT 'idle',
  contexto      JSONB DEFAULT '{}',
  lid           TEXT,
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessoes_bot_lid ON sessoes_bot(lid);

-- ──────────────────────────────────────────────────────────
-- FUNÇÃO + TRIGGERS: atualiza atualizado_em automaticamente
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION atualizar_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_usuarios_atualizado ON usuarios;
CREATE TRIGGER tg_usuarios_atualizado
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION atualizar_timestamp();

DROP TRIGGER IF EXISTS tg_transacoes_atualizado ON transacoes;
CREATE TRIGGER tg_transacoes_atualizado
  BEFORE UPDATE ON transacoes
  FOR EACH ROW EXECUTE FUNCTION atualizar_timestamp();

-- ──────────────────────────────────────────────────────────
-- MIGRATIONS SEGURAS
-- Rodar em bancos já existentes sem quebrar nada
-- ──────────────────────────────────────────────────────────
DO $$
BEGIN

  -- stripe_customer_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='usuarios' AND column_name='stripe_customer_id'
  ) THEN
    ALTER TABLE usuarios ADD COLUMN stripe_customer_id VARCHAR(100) UNIQUE;
  END IF;

  -- stripe_subscription_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='usuarios' AND column_name='stripe_subscription_id'
  ) THEN
    ALTER TABLE usuarios ADD COLUMN stripe_subscription_id VARCHAR(100);
  END IF;

  -- sobrenome
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='usuarios' AND column_name='sobrenome'
  ) THEN
    ALTER TABLE usuarios ADD COLUMN sobrenome VARCHAR(100);
  END IF;

  -- Atualiza CHECK CONSTRAINT do plano para aceitar 'basico'
  -- (remove a constraint antiga se existir e recria com os 4 valores)
  ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_plano_check;
  ALTER TABLE usuarios
    ADD CONSTRAINT usuarios_plano_check
    CHECK (plano IN ('gratuito', 'basico', 'premium', 'zen'));

  -- lid na tabela sessoes_bot
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='sessoes_bot' AND column_name='lid'
  ) THEN
    ALTER TABLE sessoes_bot ADD COLUMN lid TEXT;
  END IF;

  -- Índice stripe_subscription
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename='usuarios' AND indexname='idx_usuarios_stripe_subscription'
  ) THEN
    CREATE INDEX idx_usuarios_stripe_subscription ON usuarios(stripe_subscription_id);
  END IF;

  -- google_calendar_id por usuário (integração Google Calendar individual)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='usuarios' AND column_name='google_calendar_id'
  ) THEN
    ALTER TABLE usuarios ADD COLUMN google_calendar_id TEXT;
  END IF;

END$$;
