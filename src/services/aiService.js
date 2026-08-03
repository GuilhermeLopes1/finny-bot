const { createResponse, createStructuredResponse, outputText } = require('../config/openai');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `Você é o Finny, assistente financeiro do Allo Finanças no WhatsApp.
Responda sempre em português brasileiro, de forma direta e acolhedora.
Nunca invente dados financeiros. Use somente o contexto fornecido. Seja conciso para WhatsApp.`;

const INTENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['create_transaction', 'create_multiple_transactions', 'query_expenses', 'query_income', 'query_balance', 'query_category', 'monthly_summary', 'set_goal', 'check_goal', 'greeting', 'help', 'unknown'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    clarification_needed: { type: 'boolean' },
    clarification_question: { type: ['string', 'null'] },
    transactions: { type: 'array', maxItems: 30, items: {
      type: 'object', additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['expense', 'income'] }, amount: { type: 'number', minimum: 0 },
        description: { type: 'string' }, category: { type: 'string' }, date: { type: ['string', 'null'] },
      }, required: ['type', 'amount', 'description', 'category', 'date'],
    } },
    filters: { type: 'object', additionalProperties: false, properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'last_month'] },
      category: { type: ['string', 'null'] }, type: { type: 'string', enum: ['expense', 'income', 'all'] },
    }, required: ['period', 'category', 'type'] },
  },
  required: ['intent', 'confidence', 'clarification_needed', 'clarification_question', 'transactions', 'filters'],
};

async function parseIntent(userMessage, conversationHistory = []) {
  const history = conversationHistory.slice(-6).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1200) }));
  try {
    const result = await createStructuredResponse({
      instructions: `${SYSTEM_PROMPT}\nClassifique a intenção e extraia transações. Hoje é ${new Date().toISOString().slice(0, 10)}. Categorias: alimentação, transporte, moradia, saúde, educação, lazer, roupas, tecnologia, assinaturas, salário, freelance, investimentos, outros. Datas relativas devem considerar hoje.`,
      input: [...history, { role: 'user', content: String(userMessage).slice(0, 4000) }],
      name: 'finny_intent', schema: INTENT_SCHEMA, maxOutputTokens: 900,
    });
    logger.info(`Intent OpenAI: ${result.intent} (${result.confidence})`);
    return result;
  } catch (error) {
    logger.error(`Falha ao interpretar intenção: ${error.message}`);
    return { intent: 'unknown', confidence: 0, clarification_needed: true, clarification_question: 'Não entendi bem. Pode escrever de outra forma?', transactions: [], filters: { period: 'month', category: null, type: 'all' } };
  }
}

async function generateResponse(userMessage, context, conversationHistory = []) {
  try {
    const response = await createResponse({
      instructions: SYSTEM_PROMPT,
      input: [
        ...conversationHistory.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1200) })),
        { role: 'user', content: `${String(userMessage).slice(0, 3000)}\n\nContexto financeiro verificado pelo servidor:\n${JSON.stringify(context).slice(0, 10000)}` },
      ],
      max_output_tokens: 500,
      text: { verbosity: 'low' },
    });
    return outputText(response) || 'Não consegui responder agora. Tente novamente.';
  } catch (error) {
    logger.error(`generateResponse OpenAI: ${error.message}`);
    return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente.';
  }
}

async function generateSmartAlerts(comparison) {
  const { thisMonth, lastMonth, expenseDiff } = comparison;
  const alerts = [];
  if (expenseDiff !== null && expenseDiff > 30) alerts.push({ type: 'expense_spike', message: `⚠️ Você gastou ${expenseDiff.toFixed(0)}% a mais que o mês passado!` });
  for (const [category, amount] of Object.entries(thisMonth.byCategory || {})) {
    const lastAmount = lastMonth.byCategory?.[category] || 0;
    const diff = lastAmount > 0 ? ((amount - lastAmount) / lastAmount) * 100 : 0;
    if (diff > 50 && amount > 50) alerts.push({ type: 'category_spike', category, message: `📊 Seu gasto com ${category} aumentou ${diff.toFixed(0)}% este mês.` });
  }
  if (thisMonth.balance > 0 && lastMonth.balance > 0 && thisMonth.balance > lastMonth.balance) alerts.push({ type: 'savings_improvement', message: '✅ Você está economizando mais que o mês passado.' });
  return alerts;
}

async function generateGoalAlerts(goals, summary) {
  const alerts = [];
  for (const goal of goals || []) {
    if (goal.type !== 'expense_limit' || !goal.category || !goal.limit) continue;
    const spent = summary.byCategory?.[goal.category] || 0;
    const pct = (spent / goal.limit) * 100;
    if (pct >= 100) alerts.push({ type: 'goal_exceeded', message: `🚨 Você ultrapassou o limite de ${goal.category}: R$${spent.toFixed(2)} de R$${Number(goal.limit).toFixed(2)}.` });
    else if (pct >= 80) alerts.push({ type: 'goal_warning', message: `⚠️ Você usou ${pct.toFixed(0)}% do limite de ${goal.category}.` });
  }
  return alerts;
}

async function generateMonthlySummaryNarrative(summary, alerts = []) {
  return generateResponse('Crie um resumo mensal curto para WhatsApp, com um insight prudente.', { summary, alerts });
}

module.exports = { parseIntent, generateResponse, generateSmartAlerts, generateGoalAlerts, generateMonthlySummaryNarrative };
