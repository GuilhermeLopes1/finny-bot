/**
 * Webhook Controller
 * Main orchestration layer — receives WhatsApp messages and drives the full pipeline
 */

// ─────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────

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

// ✅ FIX #2: removido `const db = require(...).getDb()` no nível do módulo.
//    Firebase pode não estar pronto no momento do require.
//    Agora getDb() é lazy — chamado apenas dentro das funções, quando necessário.
function getDb() {
  return require('../config/firebase').getDb();
}

// ✅ FIX #10 (melhoria): parseFinanceMessage movido para o topo junto com os demais requires.
const { parseFinanceMessage } = require('../utils/parseFinanceMessage');

const { processVoiceMessage } = require('../services/audioService');
const { sendMessage, parseIncomingMessage, validateTwilioSignature } = require('../services/whatsappService');
const { buildFirestoreFilters, normalizeCategory, getPeriodLabel } = require('../parsers/intentParser');
const { formatCurrencyBR, getMonthRange, getCurrentMonthNameBR } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio';

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

/**
 * ✅ FIX #4: escapa caracteres reservados do XML antes de inserir no <Message>.
 * Sem isso, qualquer categoria com "&", "<" ou ">" quebra o XML do Twilio.
 */
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Monta e envia a resposta TwiML de forma segura.
 * Centralizar aqui garante que o escape nunca seja esquecido.
 */
function sendTwiml(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${escapeXml(message)}</Message></Response>`);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─────────────────────────────────────────────
// MAIN WEBHOOK HANDLER
// ─────────────────────────────────────────────

/**
 * POST /webhook
 * Entry point for all incoming WhatsApp messages
 */
async function handleWebhook(req, res) {
  try {
    // ✅ FIX #9 (melhoria): valida assinatura Twilio — bloqueia requisições forjadas.
    //    validateTwilioSignature estava importado mas nunca usado.
    if (PROVIDER === 'twilio' && !validateTwilioSignature(req)) {
      logger.warn('Twilio signature validation failed');
      return res.status(403).send('Forbidden');
    }

    const message = parseIncomingMessage(req.body, PROVIDER);

    // ✅ FIX #3: `message.userId` pode conter o prefixo "whatsapp:+55..." ou estar ausente.
    //    Usa `message.from` como fallback e sanitiza o número antes de qualquer consulta.
    const rawPhone = message.from || message.userId || '';
    const phone = rawPhone.replace(/^whatsapp:/i, '').replace(/\D/g, '');

    if (!phone) {
      logger.warn('handleWebhook: número de telefone ausente na mensagem recebida', message);
      return sendTwiml(res, '❌ Não foi possível identificar seu número. Tente novamente.');
    }

    // ✅ FIX #3 (cont.): consulta usando o número sanitizado
    const db = getDb();
    const userSnapshot = await db
      .collection('users')
      .where('phone', '==', phone)
      .get();

    if (userSnapshot.empty) {
      return sendTwiml(
        res,
        '🔒 Você precisa conectar sua conta.\n\nEntre no site e cadastre seu número de telefone.'
      );
    }

    const userId = userSnapshot.docs[0].id;

    // ✅ FIX #3 (cont.): getOrCreateUser ainda é útil para atualizar `lastSeenAt`,
    //    mas não precisamos do retorno — o userId já foi obtido acima.
    await getOrCreateUser(userId);

    const text = (message.text || message.body || '').toLowerCase().trim();

    // ── Saudação ──────────────────────────────────────────────────────────────
    if (text.includes('oi') || text.includes('ola') || text.includes('olá')) {
      return sendTwiml(
        res,
        'Olá! 👋 Sou o FinnyBot.\n\nMe diga algo como:\n• "gastei 50"\n• "ganhei 1000"\n• "saldo"'
      );
    }

    // ── Saldo ─────────────────────────────────────────────────────────────────
    if (text.includes('saldo')) {
      const { start, end } = getMonthRange();
      const summary = await getTransactionSummary(userId, start, end);

      const fmt = (v) => formatCurrencyBR(Number(v || 0));
      const saldoEmoji = summary.balance >= 0 ? '😊' : '⚠️';

      return sendTwiml(
        res,
        `💰 *Resumo do mês*\n\nReceitas: ${fmt(summary.totalIncome)}\nGastos: ${fmt(summary.totalExpenses)}\nSaldo: ${fmt(summary.balance)} ${saldoEmoji}`
      );
    }

    // ── Análise ───────────────────────────────────────────────────────────────
    if (text.includes('analise') || text.includes('análise')) {
      const { start, end } = getMonthRange();
      const summary    = await getTransactionSummary(userId, start, end);
      const comparison = await getMonthComparison(userId);

      const fmt = (v) => formatCurrencyBR(Number(v || 0));
      let reply = `📊 *Análise do mês*\n\n`;
      reply += `💸 Total gasto: ${fmt(summary.totalExpenses)}\n`;

      if (summary.topCategory) {
        const [cat, value] = summary.topCategory;
        reply += `🏆 Maior gasto: ${cat} — ${fmt(value)}\n`;
      }

      if (comparison.expenseDiff !== null) {
        const diff = Math.abs(comparison.expenseDiff).toFixed(0);
        reply +=
          comparison.expenseDiff > 0
            ? `⚠️ Seus gastos aumentaram ${diff}% em relação ao mês passado\n`
            : `✅ Seus gastos diminuíram ${diff}% em relação ao mês passado\n`;
      }

      if (summary.topCategory) {
        reply += `\n💡 Dica: tente reduzir gastos com *${summary.topCategory[0]}*`;
      }

      return sendTwiml(res, reply);
    }

    // ── Fallback: tenta interpretar como lançamento financeiro ────────────────
    const parsed = await parseFinanceMessage(text, userId);

    let reply =
      'Não entendi 🤔\n\nTente algo como:\n• "gastei 50"\n• "ganhei 1000"\n• "saldo"';

    if (parsed.type === 'expense' || parsed.type === 'income') {
      logger.info('Parsed finance message:', parsed);

      await saveTransaction(userId, {
        type:        parsed.type,
        amount:      parsed.amount,
        description: parsed.originalText || parsed.category,
        category:    parsed.category,
      });

      const emoji = parsed.type === 'income' ? '💰' : '💸';
      const label = parsed.type === 'income' ? 'Receita' : 'Gasto';
      const fmt   = (v) => formatCurrencyBR(Number(v || 0));

      reply = `${emoji} ${label} registrada!\n${fmt(parsed.amount)} - ${parsed.category}`;

      if (parsed.type === 'expense') {
        const { start, end } = getMonthRange();
        const summary        = await getTransactionSummary(userId, start, end);
        const totalCategory  = summary.byCategory?.[parsed.category] || 0;

        reply += `\n\n📊 Total com ${parsed.category} este mês: ${fmt(totalCategory)}`;

        if (summary.balance < 0) {
          reply += `\n⚠️ Você está com saldo negativo`;
        }

        const alertMsg = await sendSmartAlerts(userId);
        if (alertMsg) {
          reply += `\n\n🚨 *Atenção:*\n${alertMsg}`;
        }
      }
    }

    // 🧠 Aprendizado automático
    if (parsed.originalText && parsed.category) {
      await db
        .collection('users')
        .doc(userId)
        .collection('learning')
        .doc(parsed.originalText)
        .set({ keyword: parsed.originalText, category: parsed.category });
    }

    return sendTwiml(res, reply);

  } catch (error) {
    logger.error('handleWebhook error:', error);

    // ✅ FIX #4 (aplicado também no catch): usa sendTwiml para garantir XML válido
    return sendTwiml(res, 'Erro 😕');
  }
}

// ─────────────────────────────────────────────
// MESSAGE PROCESSING PIPELINE
// ─────────────────────────────────────────────

/**
 * ✅ FIX #1: função `processMessage` restaurada como async function completa.
 *    O bloco `/* ... *\/` original fechava apenas os Steps 1-2, fazendo com que
 *    os Steps 3-7 ficassem FORA de qualquer função — código órfão no nível
 *    do módulo, causando SyntaxError / ReferenceError no boot do servidor.
 */
async function processMessage(message) {
  const { from, type } = message;
  const userId = (from || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  let text = message.text;

  // ── Step 1: Ensure user exists ──
  await getOrCreateUser(from);

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
      if (intent.clarification_needed) {
        return intent.clarification_question || 'Não entendi bem. Pode reformular? 😊';
      }
      return handleUnknown(rawText, historyMessages);
  }
}

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────

async function handleCreateTransaction(intent, rawText, userId, historyMessages) {
  const transactions = intent.transactions || [];

  if (transactions.length === 0) {
    return await generateResponse(rawText, { error: 'no_transaction_found' }, historyMessages);
  }

  const tx = transactions[0];

  if (!tx.amount || tx.amount <= 0) {
    return 'Não consegui identificar o valor. Pode repetir? Ex: "gastei 50 no mercado"';
  }

  await saveTransaction(userId, tx);

  const typeLabel = tx.type === 'income' ? 'receita' : 'gasto';
  const emoji     = tx.type === 'income' ? '💰' : '💸';

  return `${emoji} ${capitalize(typeLabel)} registrado!\n*${tx.description}*\nValor: ${formatCurrencyBR(tx.amount)}\nCategoria: ${tx.category}`;
}

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

async function handleQueryExpenses(intent, userId, rawText, historyMessages) {
  const filters  = buildFirestoreFilters({ ...intent.filters, type: 'expense' });
  const summary  = await getTransactionSummary(userId, filters.startDate, filters.endDate);
  const period   = intent.filters?.period || 'month';
  const periodLabel = getPeriodLabel(period);

  if (summary.totalExpenses === 0) {
    return `Você não tem gastos registrados ${periodLabel}. 🎉`;
  }

  return await generateResponse(
    rawText,
    { totalExpenses: summary.totalExpenses, period: periodLabel, byCategory: summary.byCategory },
    historyMessages
  );
}

async function handleQueryIncome(intent, userId, rawText, historyMessages) {
  const filters      = buildFirestoreFilters({ ...intent.filters, type: 'income' });
  const transactions = await queryTransactions(userId, { ...filters, type: 'income' });
  const total        = transactions.reduce((s, t) => s + t.amount, 0);
  const period       = intent.filters?.period || 'month';
  const periodLabel  = getPeriodLabel(period);

  if (total === 0) {
    return `Você não tem receitas registradas ${periodLabel}.`;
  }

  return await generateResponse(
    rawText,
    { totalIncome: total, period: periodLabel, count: transactions.length },
    historyMessages
  );
}

async function handleQueryBalance(intent, userId, historyMessages) {
  const { start, end } = getMonthRange();
  const summary        = await getTransactionSummary(userId, start, end);
  const month          = getCurrentMonthNameBR();
  const emoji          = summary.balance >= 0 ? '😊' : '😟';

  return `${emoji} *Saldo de ${month}:*\n💰 Receitas: ${formatCurrencyBR(summary.totalIncome)}\n💸 Gastos: ${formatCurrencyBR(summary.totalExpenses)}\n📊 Saldo: ${formatCurrencyBR(summary.balance)}`;
}

async function handleQueryCategory(intent, userId, rawText, historyMessages) {
  const category     = normalizeCategory(intent.filters?.category);
  const filters      = buildFirestoreFilters({ ...intent.filters, type: 'expense', category });
  const transactions = await queryTransactions(userId, filters);
  const total        = transactions.reduce((s, t) => s + t.amount, 0);
  const period       = intent.filters?.period || 'month';
  const periodLabel  = getPeriodLabel(period);

  if (!category || total === 0) {
    return `Você não tem gastos em ${category || 'essa categoria'} ${periodLabel}.`;
  }

  return await generateResponse(
    rawText,
    { category, total, period: periodLabel, count: transactions.length },
    historyMessages
  );
}

async function handleMonthlySummary(userId) {
  const { start, end } = getMonthRange();
  const summary        = await getTransactionSummary(userId, start, end);
  const comparison     = await getMonthComparison(userId);
  const alerts         = await generateSmartAlerts(comparison);
  const goals          = await getUserGoals(userId);
  const goalAlerts     = await generateGoalAlerts(goals, summary);

  return await generateMonthlySummaryNarrative(summary, [...alerts, ...goalAlerts]);
}

async function handleGreeting(userId, rawText, historyMessages) {
  const hour = new Date().getHours();
  let greeting = 'Olá';
  if (hour < 12)       greeting = 'Bom dia';
  else if (hour < 18)  greeting = 'Boa tarde';
  else                 greeting = 'Boa noite';

  const isFirstTime = (historyMessages || []).length <= 2;

  if (isFirstTime) {
    return `${greeting}! 👋 Sou o *Finny*, seu assistente financeiro pessoal.\n\nPosso te ajudar a:\n💸 Registrar gastos e receitas\n📊 Ver resumos do mês\n🎯 Acompanhar metas\n\nExperimente: _"gastei 50 no mercado"_ ou _"quanto gastei esse mês?"_`;
  }

  return `${greeting}! 😊 Como posso te ajudar hoje?`;
}

async function handleSetGoal(intent, userId, rawText, historyMessages) {
  return await generateResponse(rawText, { note: 'goal_setting_in_development' }, historyMessages);
}

async function handleCheckGoals(userId) {
  const goals = await getUserGoals(userId);

  if (goals.length === 0) {
    return 'Você ainda não tem metas configuradas. Para criar uma, diga algo como: "quero gastar no máximo R$500 com alimentação esse mês".';
  }

  const { start, end } = getMonthRange();
  const summary        = await getTransactionSummary(userId, start, end);
  const alerts         = await generateGoalAlerts(goals, summary);

  if (alerts.length === 0) {
    return '✅ Todas as suas metas estão dentro do limite!';
  }

  return alerts.map((a) => a.message).join('\n');
}

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

async function handleUnknown(rawText, historyMessages) {
  return await generateResponse(rawText, { context: 'unknown_intent' }, historyMessages);
}

// ─────────────────────────────────────────────
// SMART ALERTS
// ─────────────────────────────────────────────

async function sendSmartAlerts(userId) {
  try {
    const comparison = await getMonthComparison(userId);
    const alerts     = await generateSmartAlerts(comparison);

    if (!alerts || alerts.length === 0) return null;

    const important = alerts.filter(
      (a) => a.type === 'expense_spike' || a.type === 'goal_exceeded'
    );

    if (important.length === 0) return null;

    return important.map((a) => a.message).join('\n');
  } catch (e) {
    logger.error('Erro ao gerar alertas:', e);
    return null;
  }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

async function handleHealthCheck(req, res) {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    provider:  PROVIDER,
    version:   process.env.npm_package_version || '1.0.0',
  });
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = { handleWebhook, handleHealthCheck };
