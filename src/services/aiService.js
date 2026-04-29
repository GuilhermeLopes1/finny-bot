/**
 * AI Service — OpenAI GPT integration
 * Handles intent detection, transaction extraction, and conversational responses
 */

const OpenAI = require('openai');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um assistente financeiro pessoal inteligente integrado ao WhatsApp. 
Seu nome é "Finny". Você responde SEMPRE em português brasileiro, com tom amigável, direto e acolhedor.
Você ajuda usuários a gerenciar suas finanças pessoais de forma simples e natural.

## Suas responsabilidades:
1. Identificar e registrar transações financeiras (gastos e receitas)
2. Responder perguntas sobre gastos, saldos e categorias
3. Gerar resumos mensais e insights financeiros
4. Detectar padrões e alertar sobre comportamentos fora do comum
5. Sugerir melhorias financeiras quando relevante

## Categorias disponíveis:
alimentação, transporte, moradia, saúde, educação, lazer, roupas, 
tecnologia, assinaturas, salário, freelance, investimentos, outros

## Exemplos de transações que você deve reconhecer:
- "gastei 50 no mercado" → expense, R$50, alimentação
- "paguei 30 de uber" → expense, R$30, transporte
- "recebi 1200 de salário" → income, R$1200, salário
- "foi 25 no ifood" → expense, R$25, alimentação
- "comprei tênis por 200 reais" → expense, R$200, roupas
- "paguei a netflix, 45 conto" → expense, R$45, assinaturas
- "100 de luz esse mês" → expense, R$100, moradia

## Regras importantes:
- Seja conciso nas respostas para WhatsApp (máx 3-4 linhas quando possível)
- Use emojis com moderação (apenas quando ajudam)
- Nunca invente dados financeiros
- Se não entender, peça esclarecimento de forma natural
- Datas relativas: "ontem", "semana passada", "mês passado" devem ser interpretadas corretamente
`;

// ─────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'create_transaction',
        'create_multiple_transactions',
        'query_expenses',
        'query_income',
        'query_balance',
        'query_category',
        'monthly_summary',
        'set_goal',
        'check_goal',
        'greeting',
        'help',
        'unknown',
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['expense', 'income'] },
          amount: { type: 'number' },
          description: { type: 'string' },
          category: { type: 'string' },
          date: { type: 'string', description: 'ISO 8601 date or null for today' },
        },
        required: ['type', 'amount', 'description', 'category'],
      },
    },
    filters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month', 'last_month', 'custom'] },
        category: { type: 'string' },
        type: { type: 'string', enum: ['expense', 'income', 'all'] },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
      },
    },
    clarification_needed: { type: 'boolean' },
    clarification_question: { type: 'string' },
  },
  required: ['intent', 'confidence'],
};

/**
 * Parse user message intent using GPT with structured output
 */
async function parseIntent(userMessage, conversationHistory = []) {
  const today = new Date().toISOString().split('T')[0];

  const messages = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}

Hoje é ${today}. Analise a mensagem do usuário e retorne um JSON estruturado identificando a intenção e extraindo dados relevantes.

Para transações, extraia: type (expense/income), amount (número), description, category, date (ISO ou null para hoje).
Para consultas, extraia: period (today/week/month/last_month), category (se mencionada), type (expense/income/all).

Retorne APENAS JSON válido, sem markdown, sem explicações.`,
    },
    ...conversationHistory.slice(-6), // Last 6 messages for context
    { role: 'user', content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    response_format: { type: 'json_object' },
    temperature: 0.1, // Low temp for consistent parsing
    max_tokens: 500,
  });

  const raw = response.choices[0].message.content;

  try {
    const parsed = JSON.parse(raw);
    logger.info(`Intent parsed: ${parsed.intent} (confidence: ${parsed.confidence})`);
    return parsed;
  } catch (e) {
    logger.error('Failed to parse intent JSON:', raw);
    return { intent: 'unknown', confidence: 0 };
  }
}

// ─────────────────────────────────────────────
// CONVERSATIONAL RESPONSE
// ─────────────────────────────────────────────

/**
 * Generate a natural conversational response given context and data
 */
async function generateResponse(userMessage, context, conversationHistory = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory.slice(-8),
    {
      role: 'user',
      content: userMessage,
    },
    {
      role: 'system',
      content: `Contexto dos dados financeiros para responder: ${JSON.stringify(context)}
      
Responda de forma natural, amigável e concisa em português brasileiro. 
Use os dados do contexto para dar uma resposta precisa.
Formate valores monetários como R$X.XXX,XX quando relevante.`,
    },
  ];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.7,
    max_tokens: 300,
  });

  return response.choices[0].message.content.trim();
}

// ─────────────────────────────────────────────
// SMART ALERTS
// ─────────────────────────────────────────────

/**
 * Generate smart alerts based on spending patterns
 */
async function generateSmartAlerts(comparison) {
  const { thisMonth, lastMonth, expenseDiff } = comparison;

  const alerts = [];

  // Overall expense increase
  if (expenseDiff !== null && expenseDiff > 30) {
    alerts.push({
      type: 'expense_spike',
      message: `⚠️ Você gastou ${expenseDiff.toFixed(0)}% a mais que o mês passado!`,
    });
  }

  // Category spikes
  for (const [category, amount] of Object.entries(thisMonth.byCategory)) {
    const lastAmount = lastMonth.byCategory[category] || 0;
    if (lastAmount > 0) {
      const diff = ((amount - lastAmount) / lastAmount) * 100;
      if (diff > 50 && amount > 50) {
        alerts.push({
          type: 'category_spike',
          category,
          message: `📊 Seu gasto com ${category} aumentou ${diff.toFixed(0)}% este mês.`,
        });
      }
    }
  }

  // Positive: saving more
  if (thisMonth.balance > 0 && lastMonth.balance > 0 && thisMonth.balance > lastMonth.balance) {
    alerts.push({
      type: 'savings_improvement',
      message: `✅ Parabéns! Você está economizando mais que o mês passado.`,
    });
  }

  return alerts;
}

/**
 * Generate goal proximity alerts
 */
async function generateGoalAlerts(goals, summary) {
  const alerts = [];

  for (const goal of goals) {
    if (goal.type === 'expense_limit' && goal.category) {
      const spent = summary.byCategory[goal.category] || 0;
      const pct = (spent / goal.limit) * 100;

      if (pct >= 80 && pct < 100) {
        alerts.push({
          type: 'goal_warning',
          message: `⚠️ Você usou ${pct.toFixed(0)}% do limite de ${goal.category} (R$${spent.toFixed(2)} de R$${goal.limit}).`,
        });
      } else if (pct >= 100) {
        alerts.push({
          type: 'goal_exceeded',
          message: `🚨 Você ultrapassou o limite de ${goal.category}! Gastou R$${spent.toFixed(2)} (limite: R$${goal.limit}).`,
        });
      }
    }
  }

  return alerts;
}

/**
 * Generate a full monthly summary narrative using GPT
 */
async function generateMonthlySummaryNarrative(summary, alerts = []) {
  const prompt = `Com base nos dados financeiros abaixo, gere um resumo mensal amigável e informativo em português brasileiro para WhatsApp. Seja conciso (máx 8 linhas), use emojis relevantes.

Dados:
- Receitas: R$${summary.totalIncome.toFixed(2)}
- Gastos: R$${summary.totalExpenses.toFixed(2)}
- Saldo: R$${summary.balance.toFixed(2)}
- Categorias: ${JSON.stringify(summary.byCategory)}
- Maior categoria: ${summary.topCategory ? summary.topCategory[0] + ' (R$' + summary.topCategory[1].toFixed(2) + ')' : 'nenhuma'}
- Alertas: ${alerts.map((a) => a.message).join('; ') || 'nenhum'}

Formato sugerido:
📊 *Resumo do mês*
...dados...
💡 Insight...`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Você é um assistente financeiro. Responda em pt-BR.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    max_tokens: 400,
  });

  return response.choices[0].message.content.trim();
}

module.exports = {
  parseIntent,
  generateResponse,
  generateSmartAlerts,
  generateGoalAlerts,
  generateMonthlySummaryNarrative,
};
