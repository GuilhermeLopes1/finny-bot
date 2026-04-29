# 🤖 Finny — Assistente Financeiro WhatsApp + Firebase

> Sistema completo de assistente financeiro com IA integrado ao WhatsApp, Firebase Firestore e painel web.

---

## 📐 Arquitetura

```
whatsapp-finance-bot/
├── src/
│   ├── server.js                    ← Entry point (Express)
│   ├── config/
│   │   └── firebase.js              ← Firebase Admin SDK init
│   ├── controllers/
│   │   └── webhookController.js     ← Orchestração principal do pipeline
│   ├── services/
│   │   ├── aiService.js             ← GPT-4o-mini: intent + respostas
│   │   ├── firebaseService.js       ← CRUD Firestore completo
│   │   ├── audioService.js          ← Transcrição Whisper
│   │   └── whatsappService.js       ← Twilio + Z-API abstraction
│   ├── parsers/
│   │   └── intentParser.js          ← Filtros, categorias, datas
│   ├── middleware/
│   │   └── rateLimiter.js           ← Proteção contra abuso
│   └── utils/
│       ├── logger.js                ← Winston logging
│       └── dateUtils.js             ← Datas BR (mês, semana, hoje)
├── web-dashboard/
│   └── index.html                   ← Dashboard web (Firebase JS SDK)
├── firestore.rules                  ← Regras de segurança Firestore
├── firestore.indexes.json           ← Índices compostos necessários
├── .env.example                     ← Variáveis de ambiente
└── package.json
```

---

## 🚀 Setup Rápido

### 1. Clone e instale

```bash
git clone <repo>
cd whatsapp-finance-bot
npm install
cp .env.example .env
```

### 2. Configure as variáveis

Edite `.env` com suas credenciais:

| Variável | Descrição |
|---|---|
| `OPENAI_API_KEY` | Chave da OpenAI (GPT-4o-mini + Whisper) |
| `WHATSAPP_PROVIDER` | `twilio` ou `zapi` |
| `TWILIO_ACCOUNT_SID` | Account SID do Twilio |
| `TWILIO_AUTH_TOKEN` | Auth Token do Twilio |
| `TWILIO_WHATSAPP_FROM` | Número WhatsApp Twilio (`whatsapp:+14155238886`) |
| `FIREBASE_PROJECT_ID` | ID do projeto Firebase |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Private key do service account |

### 3. Firebase

```bash
# Instale o Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Deploy regras e índices
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Inicie o servidor

```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

### 5. Exponha o webhook (dev)

```bash
# Use ngrok para expor localmente
npx ngrok http 3000

# Copie a URL HTTPS gerada, ex:
# https://abc123.ngrok.io/webhook
```

### 6. Configure no Twilio

No [Console Twilio](https://console.twilio.com):
1. WhatsApp → Sandbox Settings
2. Cole a URL: `https://SEU_DOMINIO/webhook`
3. Método: `POST`

---

## 📱 Fluxo de Mensagens

```
WhatsApp User
     │
     ▼
POST /webhook
     │
     ├─ [audio] → audioService → Whisper → texto
     │
     ▼
parseIncomingMessage()
     │
     ▼
getOrCreateUser()     ← Firebase: users/{id}
     │
     ▼
getConversationHistory()  ← últimas 10 msgs
     │
     ▼
parseIntent()         ← GPT-4o-mini → JSON estruturado
     │
     ├── create_transaction  → saveTransaction() → Firebase
     ├── query_expenses      → queryTransactions() → resposta
     ├── query_balance       → getTransactionSummary()
     ├── monthly_summary     → generateMonthlySummaryNarrative()
     ├── greeting            → resposta contextual
     └── unknown             → generateResponse() fallback
     │
     ▼
sendMessage()         ← Twilio / Z-API
     │
     ▼
saveConversationMessage()  ← histórico para contexto
     │
     ▼ (async, após transações)
checkAndSendAlerts()  ← alertas inteligentes
```

---

## 🧠 Exemplos de Uso

### Registrar Gastos

```
Usuário: "gastei 50 no mercado"
Finny:   "💸 Gasto registrado!
          *Mercado*
          Valor: R$50,00
          Categoria: alimentação"

Usuário: "paguei 30 de uber ontem"
Finny:   "💸 Gasto registrado!
          *Uber*
          Valor: R$30,00
          Categoria: transporte"

Usuário: "foi 45 na netflix"
Finny:   "💸 Gasto registrado!
          *Netflix*
          Valor: R$45,00
          Categoria: assinaturas"
```

### Registrar Receitas

```
Usuário: "recebi 1200 de salário"
Finny:   "💰 Receita registrada!
          *Salário*
          Valor: R$1.200,00
          Categoria: salário"
```

### Consultas

```
Usuário: "quanto eu gastei esse mês?"
Finny:   "Você gastou R$1.250 este mês em 23 transações."

Usuário: "quanto foi com alimentação?"
Finny:   "Você gastou R$320 em alimentação este mês."

Usuário: "qual meu saldo?"
Finny:   "💰 Receitas: R$2.000,00
          💸 Gastos:   R$1.250,00
          📊 Saldo:    R$750,00"
```

### Resumo Mensal

```
Usuário: "resumo do mês"
Finny:   "📊 Resumo de abril
          Você recebeu R$2.000 e gastou R$1.500.
          Sua maior categoria foi alimentação (R$450).
          Você economizou R$500. 💪"
```

### Alertas Automáticos

```
Finny: "⚠️ Você gastou 40% a mais que o mês passado!"
Finny: "📊 Seu gasto com transporte aumentou 65% este mês."
Finny: "✅ Parabéns! Você está economizando mais que o mês passado."
```

---

## 🗄️ Estrutura Firestore

```
users/
  {phoneNumber}/
    phoneNumber: "5511999999999"
    createdAt: Timestamp
    lastSeenAt: Timestamp
    preferences: { currency, language, timezone }
    stats: { totalTransactions }

    transactions/
      {txId}/
        type: "expense" | "income"
        amount: 50.00
        description: "Mercado"
        category: "alimentação"
        date: Timestamp
        createdAt: Timestamp
        source: "whatsapp"

    goals/
      {goalId}/
        type: "expense_limit"
        category: "alimentação"
        limit: 500
        active: true

conversations/
  {userId}/
    messages/
      {msgId}/
        role: "user" | "assistant"
        content: "texto"
        timestamp: Timestamp
```

---

## 🔧 Provedores WhatsApp

### Twilio (recomendado para MVP)

1. Crie conta em [twilio.com](https://twilio.com)
2. Ative o sandbox WhatsApp
3. Configure `WHATSAPP_PROVIDER=twilio` no `.env`

### Z-API (alternativa brasileira)

1. Crie instância em [z-api.io](https://z-api.io)
2. Configure `WHATSAPP_PROVIDER=zapi` no `.env`
3. Adicione `ZAPI_INSTANCE_ID`, `ZAPI_CLIENT_TOKEN`, `ZAPI_SECURITY_TOKEN`

---

## 🌐 Deploy

### Railway

```bash
# railway.app — deploy em 1 clique
railway login
railway init
railway up
railway variables set OPENAI_API_KEY=sk-...
```

### Render

```yaml
# render.yaml
services:
  - type: web
    name: finny-bot
    env: node
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

---

## 📊 Dashboard Web

Abra `web-dashboard/index.html` no browser após configurar o Firebase JS SDK:

1. Edite o objeto `firebaseConfig` com as credenciais do seu projeto
2. Faça deploy via Firebase Hosting: `firebase deploy --only hosting`

---

## 🔒 Segurança

- Validação de assinatura Twilio em produção
- Rate limiter: 20 req/min por usuário
- Regras Firestore: cada usuário acessa apenas seus próprios dados
- Variáveis sensíveis via `.env` (nunca no código)
- Admin SDK: acesso server-side apenas via service account

---

## 📈 Roadmap MVP+

- [ ] Metas mensais por categoria
- [ ] Exportar relatório PDF pelo WhatsApp
- [ ] Suporte a múltiplas contas por família
- [ ] Integração com Open Banking
- [ ] Notificações agendadas (resumo semanal automático)
- [ ] Aprendendizagem de padrões de categorização por usuário
