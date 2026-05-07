# GranaZen — Controle Financeiro com WhatsApp e IA

Controle financeiro pessoal via WhatsApp, com IA para categorização automática.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Back-end | Node.js + Express |
| Banco | PostgreSQL |
| WhatsApp | Baileys (sem API oficial) |
| IA | OpenAI GPT-4o-mini (opcional) |
| Hospedagem | Railway (dev) → KingHost (prod) |

---

## Estrutura de pastas

```
granazen/
├── server.js              ← ponto de entrada
├── package.json
├── .env.example           ← copie para .env e preencha
├── Procfile               ← usado pelo Railway
├── database/
│   ├── schema.sql         ← crie o banco com este arquivo
│   └── db.js              ← pool de conexão PostgreSQL
├── middleware/
│   └── auth.js            ← valida JWT nas rotas protegidas
├── routes/
│   ├── auth.js            ← POST /api/auth/cadastro e /login
│   ├── transactions.js    ← CRUD /api/transactions
│   └── whatsapp.js        ← GET /api/whatsapp/status etc.
├── bot/
│   └── handler.js         ← lógica do bot Baileys
└── public/
    ├── index.html         ← landing page
    ├── dashboard.html     ← painel do usuário
    ├── login.html         ← login/cadastro
    └── api.js             ← cliente JS para o front-end
```

---

## Configuração local (desenvolvimento)

### 1. Instale as dependências

```bash
npm install
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
# Edite o .env com suas credenciais
```

### 3. Crie o banco de dados

Se tiver PostgreSQL local:
```bash
psql -U postgres -c "CREATE DATABASE granazen;"
psql -U postgres -d granazen -f database/schema.sql
```

Configure no `.env`:
```
DATABASE_URL=postgresql://postgres:senha@localhost:5432/granazen
```

### 4. Rode o servidor

```bash
npm run dev   # com nodemon (reinicia ao salvar)
# ou
npm start     # produção
```

Acesse: http://localhost:3000

### 5. Conecte o WhatsApp

- Abra http://localhost:3000
- No terminal aparece um QR Code — escaneie com o WhatsApp
- Após conectar, vá em Configurações → Vincular WhatsApp no painel

---

## Deploy no Railway (gratuito para testar)

### 1. Crie uma conta em railway.app

### 2. Crie um novo projeto

```bash
# Instale a CLI do Railway
npm install -g @railway/cli

railway login
railway init
railway up
```

### 3. Adicione o PostgreSQL

No painel Railway: **New** → **Database** → **PostgreSQL**

Copie a `DATABASE_URL` gerada e adicione nas variáveis do serviço.

### 4. Execute o schema

```bash
# Via Railway CLI
railway run psql $DATABASE_URL -f database/schema.sql
```

### 5. Configure as variáveis no Railway

No painel: **Variables** → adicione:
```
JWT_SECRET=string_aleatoria_longa
NODE_ENV=production
APP_URL=https://seu-projeto.railway.app
OPENAI_API_KEY=sk-... (opcional)
```

---

## Migrar para KingHost

Os mesmos arquivos funcionam. Na KingHost com Node.js:

1. Suba os arquivos via FTP ou Git
2. Contrate o PostgreSQL separadamente ou use Supabase (free tier)
3. Configure as variáveis de ambiente no painel KingHost
4. O `Procfile` não é necessário — use o painel para definir `node server.js`

---

## API — Endpoints principais

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/cadastro` | Cria conta |
| POST | `/api/auth/login` | Faz login → retorna JWT |
| GET | `/api/auth/me` | Perfil do usuário logado |
| GET | `/api/transactions` | Lista transações (com filtros) |
| GET | `/api/transactions/resumo` | Resumo do dashboard |
| POST | `/api/transactions` | Cria transação |
| PUT | `/api/transactions/:id` | Atualiza transação |
| DELETE | `/api/transactions/:id` | Remove transação |
| GET | `/api/transactions/contas` | Lista contas bancárias |
| GET | `/api/transactions/categorias` | Lista categorias |
| GET | `/api/whatsapp/status` | Status do bot WhatsApp |
| POST | `/api/whatsapp/vincular` | Vincula telefone ao usuário |

Todas as rotas (exceto `/api/auth/*`) exigem header:
```
Authorization: Bearer <token>
```

---

## Como o bot WhatsApp funciona

1. O Baileys conecta ao WhatsApp via WebSocket (sem API oficial paga)
2. O QR code aparece no terminal na primeira execução
3. Quando uma mensagem chega, `bot/handler.js` verifica se o número está vinculado
4. Tenta interpretar a mensagem com regex; se não funcionar, usa GPT-4o-mini
5. Registra a transação no PostgreSQL e responde ao usuário

**Exemplos de mensagens que o bot entende:**
- "Gastei 45 no almoço"
- "Recebi 2000 de salário"  
- "Conta de luz 180 reais"
- "resumo" → mostra saldo do mês
- "ajuda" → lista de comandos

---

## Próximos passos sugeridos

- [ ] Página de configurações (contas bancárias, categorias personalizadas)
- [ ] Exportação de relatório em PDF/Excel
- [ ] Gráficos avançados no dashboard (Chart.js já está disponível)
- [ ] Notificação de lembretes também por e-mail (Nodemailer)
- [ ] Sistema de planos (free/premium) com Stripe
- [ ] Gestão compartilhada (casal/família)
