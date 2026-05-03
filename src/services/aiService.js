/**
 * AI Service — Anthropic Claude integration
 * Handles intent detection, transaction extraction, and conversational responses
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

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
- Datas relativas: "ontem", "semana passada", "mês passado" devem ser interpretadas corretamente`;

// ─────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────

async function parseIntent(userMessage, conversationHistory = []) {
  const today = new Date().toISOString().split('T')[0];

  const historyFormatted = conversationHistory.slice(-6).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const prompt = `${SYSTEM_PROMPT}

Hoje é ${today}. Analise a mensagem do usuário e retorne um JSON estruturado identificando a intenção e extraindo dados relevantes.

Para transações, extraia: type (expense/income), amount (número), description, category, date (ISO ou null para hoje).
Para consultas, extraia: period (today/week/month/last_month), category (se mencionada), type (expense/income/all).

Intents possíveis: create_transaction, create_multiple_transactions, query_expenses, query_income, query_balance, query_category, monthly_summary, set_goal, check_goal, greeting, help, unknown.

Retorne APENAS JSON válido, sem markdown, sem explicações.

Mensagem do usuário: "${userMessage}"`;

  try {
    const messages = [
      ...historyFormatted,
      { role: 'user', content: prompt }
    ];

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages
    });

    const raw = response.content[0].text.trim();
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    logger.info(`Intent parsed: ${parsed.intent} (confidence: ${parsed.confidence})`);
    return parsed;
  } catch (e) {
    logger.error('Failed to parse intent:', e.message);
    return { intent: 'unknown', confidence: 0 };
  }
}

// ─────────────────────────────────────────────
// CONVERSATIONAL RESPONSE
// ─────────────────────────────────────────────

async function generateResponse(userMessage, context, conversationHistory = []) {
  const historyFormatted = conversationHistory.slice(-8).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const userContent = `${userMessage}\n\nContexto dos dados financeiros: ${JSON.stringify(context)}\n\nResponda de forma natural, amigável e concisa em português brasileiro. Use os dados do contexto para dar uma resposta precisa. Formate valores monetários como R$X.XXX,XX quando relevante.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        ...historyFormatted,
        { role: 'user', content: userContent }
      ]
    });

    return response.content[0].text.trim();
  } catch (e) {
    logger.error('generateResponse error:', e.message);
    return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente. 😊';
  }
}

// ─────────────────────────────────────────────
// SMART ALERTS
// ─────────────────────────────────────────────

async function generateSmartAlerts(comparison) {
  const { thisMonth, lastMonth, expenseDiff } = comparison;
  const alerts = [];

  if (expenseDiff !== null && expenseDiff > 30) {
    alerts.push({
      type: 'expense_spike',
      message: `⚠️ Você gastou ${expenseDiff.toFixed(0)}% a mais que o mês passado!`,
    });
  }

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

  if (thisMonth.balance > 0 && lastMonth.balance > 0 && thisMonth.balance > lastMonth.balance) {
    alerts.push({
      type: 'savings_improvement',
      message: `✅ Parabéns! Você está economizando mais que o mês passado.`,
    });
  }

  return alerts;
}

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

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: 'Você é um assistente financeiro. Responda em pt-BR.',
      messages: [{ role: 'user', content: prompt }]
    });

    return response.content[0].text.trim();
  } catch (e) {
    logger.error('generateMonthlySummaryNarrative error:', e.message);
    return '📊 Não foi possível gerar o resumo. Tente novamente.';
  }
}

module.exports = {
  parseIntent,
  generateResponse,
  generateSmartAlerts,
  generateGoalAlerts,
  generateMonthlySummaryNarrative,
};
