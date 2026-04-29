/**
 * Webhook Controller
 * Main orchestration layer — receives WhatsApp messages and drives the full pipeline
 */

const {
  getOrCreateUser,
  saveTransaction,
  saveTransactionsBatch,
  queryTransactions,
  getTransactionSummary,
  getMonthComparison,
  getConversationHistory,
  saveConversationMessage,
  getUserGoals,
} = require('../services/firebaseService');

const {
  parseIntent,
  generateResponse,
  generateSmartAlerts,
  generateGoalAlerts,
  generateMonthlySummaryNarrative,
} = require('../services/aiService');

const db = require('../config/firebase').getDb();
const { processVoiceMessage } = require('../services/audioService');
const { sendMessage, parseIncomingMessage, validateTwilioSignature } = require('../services/whatsappService');
const { buildFirestoreFilters, normalizeCategory, getPeriodLabel } = require('../parsers/intentParser');
const { formatCurrencyBR, getMonthRange, getCurrentMonthNameBR } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio';

// ─────────────────────────────────────────────
// MAIN WEBHOOK HANDLER
// ─────────────────────────────────────────────

/**
 * POST /webhook
 * Entry point for all incoming WhatsApp messages
 */
const parseFinanceMessage = require('../utils/parseFinanceMessage.js');

async function handleWebhook(req, res) {
  try {
    const message = parseIncomingMessage(req.body, PROVIDER);
    await getOrCreateUser(message.userId);

    const text = (message.text || message.body || '').toLowerCase();

    if (text.includes('saldo')) {
  const { start, end } = getMonthRange();

  

  const summary = await getTransactionSummary(message.userId, start, end);

const format = (v) => formatCurrencyBR(Number(v || 0));

const saldoEmoji = summary.balance >= 0 ? '😊' : '⚠️';

const reply = `
💰 *Resumo do mês*

Receitas: ${format(summary.totalIncome)}
Gastos: ${format(summary.totalExpenses)}
Saldo: ${format(summary.balance)} ${saldoEmoji}
`;

  res.set('Content-Type', 'text/xml');
  return res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
}
if (text.includes('analise') || text.includes('análise')) {
  const { start, end } = getMonthRange();

  const summary = await getTransactionSummary(message.userId, start, end);
  const comparison = await getMonthComparison(message.userId);

  const format = (v) => formatCurrencyBR(Number(v || 0));

  let reply = `📊 *Análise do mês*\n\n`;

  reply += `💸 Total gasto: ${format(summary.totalExpenses)}\n`;

  if (summary.topCategory) {
    const [cat, value] = summary.topCategory;
    reply += `🏆 Maior gasto: ${cat} — ${format(value)}\n`;
  }

  if (comparison.expenseDiff !== null) {
    const diff = comparison.expenseDiff.toFixed(0);

    if (comparison.expenseDiff > 0) {
      reply += `⚠️ Seus gastos aumentaram ${diff}% em relação ao mês passado\n`;
    } else {
      reply += `✅ Seus gastos diminuíram ${Math.abs(diff)}% em relação ao mês passado\n`;
    }
  }

  if (summary.topCategory) {
    reply += `\n💡 Dica: tente reduzir gastos com *${summary.topCategory[0]}*`;
  }

  res.set('Content-Type', 'text/xml');
  return res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
}

    const parsed = await parseFinanceMessage(text, message.userId);

    let reply = 'Não entendi 🤔';

if (parsed.type === 'expense' || parsed.type === 'income') {

const { getDb } = require('../config/firebase');
const db = getDb();

const userSnapshot = await db
  .collection('users')
  .where('phone', '==', message.userId)
  .get();

let userId;

if (!userSnapshot.empty) {
  userId = userSnapshot.docs[0].id;
  console.log("🔥 Usuário encontrado:", userId);
} else {
  userId = message.userId;
  console.log("⚠️ Usuário NÃO encontrado, usando telefone");
}
console.log("🧠 PARSED:", parsed);
await saveTransaction(userId, {
  type: parsed.type,
  amount: parsed.amount,
  description: parsed.originalText || parsed.category,
  category: parsed.category
});

  const emoji = parsed.type === 'income' ? '💰' : '💸';
  const label = parsed.type === 'income' ? 'Receita' : 'Gasto';
  const format = (v) => formatCurrencyBR(Number(v || 0));

  // resposta base
// resposta base
reply = `${emoji} ${label} registrada!\n${format(parsed.amount)} - ${parsed.category}`;

// 🔥 tudo junto
if (parsed.type === 'expense') {
  const { start, end } = getMonthRange();
  const summary = await getTransactionSummary(message.userId, start, end);

  const totalCategory = summary.byCategory?.[parsed.category] || 0;

  reply += `\n\n📊 Total com ${parsed.category} este mês: ${format(totalCategory)}`;

  if (summary.balance < 0) {
    reply += `\n⚠️ Você está com saldo negativo`;
  }

  // 🚨 ALERTAS AUTOMÁTICOS
  const alertMsg = await sendSmartAlerts(message.userId);

  if (alertMsg) {
    reply += `\n\n🚨 *Atenção:*\n${alertMsg}`;
  }
}

}


if (parsed.originalText && parsed.category) {
  await db
    .collection('users')
    .doc(message.userId)
    .collection('learning')
    .doc(parsed.originalText)
    .set({
      keyword: parsed.originalText,
      category: parsed.category
    });
}

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);

  

  } catch (error) {
    console.error(error);

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>Erro 😕</Message>
      </Response>
    `);
  }
}

// ─────────────────────────────────────────────
// MESSAGE PROCESSING PIPELINE
// ─────────────────────────────────────────────

async function processMessage(message) {
  const { userId, from, type } = message;
  let text = message.text;

  // ── Step 1: Ensure user exists ──
  const user = await getOrCreateUser(from);

  // ── Step 2: Handle audio messages ──
  if (type === 'audio' && message.mediaUrl) {
    const result = await processVoiceMessage(message.mediaUrl, PROVIDER);
    if (!result.success || !result.text) {
      await sendMessage(from, '🎤 Não consegui entender o áudio. Pode escrever sua mensagem?');
      return;
    }
    text = result.text;
    logger.info(`Transcription from ${userId}: "${text}"`);
  }

  if (!text || text.trim().length === 0) {
    await sendMessage(from, 'Oi! Pode me enviar uma mensagem de texto ou áudio. 😊');
    return;
  }

  // ── Step 3: Load conversation history ──
  const history = await getConversationHistory(userId);
  const historyMessages = history.map((m) => ({ role: m.role, content: m.content }));

  // ── Step 4: Detect intent ──
  const intent = await parseIntent(text, historyMessages);
  logger.info(`Intent: ${JSON.stringify(intent)}`);

  // ── Step 5: Save user message to history ──
  await saveConversationMessage(userId, 'user', text);

  // ── Step 6: Route to handler ──
  let reply;
  try {
    reply = await routeIntent(intent, text, userId, from, historyMessages);
  } catch (err) {
    logger.error(`Intent routing error (${intent.intent}):`, err);
    reply = '😕 Tive um problema ao processar sua solicitação. Pode tentar novamente?';
  }

  // ── Step 7: Send reply ──
  if (reply) {
    await sendMessage(from, reply);
    await saveConversationMessage(userId, 'assistant', reply);
  }
}

// ─────────────────────────────────────────────
// INTENT ROUTER
// ─────────────────────────────────────────────

async function routeIntent(intent, rawText, userId, from, historyMessages) {
  switch (intent.intent) {
    case 'create_transaction':
      return handleCreateTransaction(intent, rawText, userId, historyMessages);

    case 'create_multiple_transactions':
      return handleMultipleTransactions(intent, rawText, userId, historyMessages);

    case 'query_expenses':
      return handleQueryExpenses(intent, userId, rawText, historyMessages);

    case 'query_income':
      return handleQueryIncome(intent, userId, rawText, historyMessages);

    case 'query_balance':
      return handleQueryBalance(intent, userId, historyMessages);

    case 'query_category':
      return handleQueryCategory(intent, userId, rawText, historyMessages);

    case 'monthly_summary':
      return handleMonthlySummary(userId);

    case 'greeting':
      return handleGreeting(userId, rawText, historyMessages);

    case 'help':
      return handleHelp();

    case 'set_goal':
      return handleSetGoal(intent, userId, rawText, historyMessages);

    case 'check_goal':
      return handleCheckGoals(userId);

    default:
      // If unknown, try GPT general response
      if (intent.clarification_needed) {
        return intent.clarification_question || 'Não entendi bem. Pode reformular? 😊';
      }
      return handleUnknown(rawText, historyMessages);
  }
}

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────

/**
 * CREATE TRANSACTION
 */
async function handleCreateTransaction(intent, rawText, userId, historyMessages) {
  const transactions = intent.transactions || [];

  if (transactions.length === 0) {
    return await generateResponse(rawText, { error: 'no_transaction_found' }, historyMessages);
  }

  const tx = transactions[0];

  // Validate
  if (!tx.amount || tx.amount <= 0) {
    return 'Não consegui identificar o valor. Pode repetir? Ex: "gastei 50 no mercado"';
  }

  const saved = await saveTransaction(userId, tx);

  const typeLabel = tx.type === 'income' ? 'receita' : 'gasto';
  const emoji = tx.type === 'income' ? '💰' : '💸';

  return `${emoji} ${capitalize(typeLabel)} registrado!\n*${tx.description}*\nValor: ${formatCurrencyBR(tx.amount)}\nCategoria: ${tx.category}`;
}

/**
 * MULTIPLE TRANSACTIONS
 */
async function handleMultipleTransactions(intent, rawText, userId, historyMessages) {
  const transactions = intent.transactions || [];

  if (transactions.length === 0) {
    return await generateResponse(rawText, { error: 'no_transactions_found' }, historyMessages);
  }

  const saved = await saveTransactionsBatch(userId, transactions);

  const lines = saved.map((tx) => {
    const emoji = tx.type === 'income' ? '💰' : '💸';
    return `${emoji} ${tx.description}: ${formatCurrencyBR(tx.amount)}`;
  });

  return `✅ ${saved.length} transações registradas:\n${lines.join('\n')}`;
}

/**
 * QUERY EXPENSES
 */
async function handleQueryExpenses(intent, userId, rawText, historyMessages) {
  const filters = buildFirestoreFilters({ ...intent.filters, type: 'expense' });
  const summary = await getTransactionSummary(userId, filters.startDate, filters.endDate);

  const period = intent.filters?.period || 'month';
  const periodLabel = getPeriodLabel(period);

  if (summary.totalExpenses === 0) {
    return `Você não tem gastos registrados ${periodLabel}. 🎉`;
  }

  const context = { totalExpenses: summary.totalExpenses, period: periodLabel, byCategory: summary.byCategory };
  return await generateResponse(rawText, context, historyMessages);
}

/**
 * QUERY INCOME
 */
async function handleQueryIncome(intent, userId, rawText, historyMessages) {
  const filters = buildFirestoreFilters({ ...intent.filters, type: 'income' });
  const transactions = await queryTransactions(userId, { ...filters, type: 'income' });

  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const period = intent.filters?.period || 'month';
  const periodLabel = getPeriodLabel(period);

  if (total === 0) {
    return `Você não tem receitas registradas ${periodLabel}.`;
  }

  return await generateResponse(rawText, { totalIncome: total, period: periodLabel, count: transactions.length }, historyMessages);
}

/**
 * QUERY BALANCE
 */
async function handleQueryBalance(intent, userId, historyMessages) {
  const { start, end } = getMonthRange();
  const summary = await getTransactionSummary(userId, start, end);

  const month = getCurrentMonthNameBR();
  const emoji = summary.balance >= 0 ? '😊' : '😟';

  return `${emoji} *Saldo de ${month}:*\n💰 Receitas: ${formatCurrencyBR(summary.totalIncome)}\n💸 Gastos: ${formatCurrencyBR(summary.totalExpenses)}\n📊 Saldo: ${formatCurrencyBR(summary.balance)}`;
}

/**
 * QUERY CATEGORY
 */
async function handleQueryCategory(intent, userId, rawText, historyMessages) {
  const category = normalizeCategory(intent.filters?.category);
  const filters = buildFirestoreFilters({ ...intent.filters, type: 'expense', category });
  const transactions = await queryTransactions(userId, filters);

  const total = transactions.reduce((s, t) => s + t.amount, 0);
  const period = intent.filters?.period || 'month';
  const periodLabel = getPeriodLabel(period);

  if (!category || total === 0) {
    return `Você não tem gastos em ${category || 'essa categoria'} ${periodLabel}.`;
  }

  return await generateResponse(
    rawText,
    { category, total, period: periodLabel, count: transactions.length },
    historyMessages
  );
}

/**
 * MONTHLY SUMMARY
 */
async function handleMonthlySummary(userId) {
  const { start, end } = getMonthRange();
  const summary = await getTransactionSummary(userId, start, end);

  // Compare with last month for alerts
  const comparison = await getMonthComparison(userId);
  const alerts = await generateSmartAlerts(comparison);

  // Goal alerts
  const goals = await getUserGoals(userId);
  const goalAlerts = await generateGoalAlerts(goals, summary);
  const allAlerts = [...alerts, ...goalAlerts];

  return await generateMonthlySummaryNarrative(summary, allAlerts);
}

/**
 * GREETING
 */
async function handleGreeting(userId, rawText, historyMessages) {
  const hour = new Date().getHours();
  let greeting = 'Olá';
  if (hour < 12) greeting = 'Bom dia';
  else if (hour < 18) greeting = 'Boa tarde';
  else greeting = 'Boa noite';

  // Check if first time
  const history = historyMessages || [];
  const isFirstTime = history.length <= 2;

  if (isFirstTime) {
    return `${greeting}! 👋 Sou o *Finny*, seu assistente financeiro pessoal.\n\nPosso te ajudar a:\n💸 Registrar gastos e receitas\n📊 Ver resumos do mês\n🎯 Acompanhar metas\n\nExperimente: _"gastei 50 no mercado"_ ou _"quanto gastei esse mês?"_`;
  }

  return `${greeting}! 😊 Como posso te ajudar hoje?`;
}

/**
 * SET GOAL
 */
async function handleSetGoal(intent, userId, rawText, historyMessages) {
  return await generateResponse(
    rawText,
    { note: 'goal_setting_in_development' },
    historyMessages
  );
}

/**
 * CHECK GOALS
 */
async function handleCheckGoals(userId) {
  const goals = await getUserGoals(userId);
  if (goals.length === 0) {
    return 'Você ainda não tem metas configuradas. Para criar uma, diga algo como: "quero gastar no máximo R$500 com alimentação esse mês".';
  }

  const { start, end } = getMonthRange();
  const summary = await getTransactionSummary(userId, start, end);
  const alerts = await generateGoalAlerts(goals, summary);

  if (alerts.length === 0) {
    return '✅ Todas as suas metas estão dentro do limite!';
  }

  return alerts.map((a) => a.message).join('\n');
}

/**
 * HELP
 */
function handleHelp() {
  return `🤖 *Finny — Seu Assistente Financeiro*

*Registrar gastos:*
• "gastei 50 no mercado"
• "paguei 30 de uber"
• "foi 25 no ifood"

*Registrar receitas:*
• "recebi 1200 de salário"
• "entrou 500 de freela"

*Consultar gastos:*
• "quanto gastei esse mês?"
• "quanto foi com alimentação?"
• "gastos dessa semana"

*Resumo:*
• "resumo do mês"
• "como estão minhas finanças?"

*Saldo:*
• "qual meu saldo?"
• "quanto tenho disponível?"`;
}

/**
 * UNKNOWN INTENT — fallback to GPT
 */
async function handleUnknown(rawText, historyMessages) {
  return await generateResponse(
    rawText,
    { context: 'unknown_intent' },
    historyMessages
  );
}

// ─────────────────────────────────────────────
// SMART ALERTS CHECK
// ─────────────────────────────────────────────

/**
 * After saving a transaction, check for alerts and send if relevant
 */

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

async function handleHealthCheck(req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    provider: PROVIDER,
    version: process.env.npm_package_version || '1.0.0',
  });
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function sendSmartAlerts(userId) {
  try {
    const comparison = await getMonthComparison(userId);
    const alerts = await generateSmartAlerts(comparison);

    if (!alerts || alerts.length === 0) return null;

    // pega só alertas importantes
    const important = alerts.filter(
      (a) => a.type === 'expense_spike' || a.type === 'goal_exceeded'
    );

    if (important.length === 0) return null;

    return important.map(a => a.message).join('\n');

  } catch (e) {
    console.error('Erro ao gerar alertas:', e);
    return null;
  }
}


module.exports = { handleWebhook, handleHealthCheck };
