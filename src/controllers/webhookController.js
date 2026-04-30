/**
 * Webhook Controller
 * Main orchestration layer â€” receives WhatsApp messages and drives the full pipeline
 */

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// IMPORTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// âœ… FIX #2: removido `const db = require(...).getDb()` no nÃ­vel do mÃ³dulo.
//    Firebase pode nÃ£o estar pronto no momento do require.
//    Agora getDb() Ã© lazy â€” chamado apenas dentro das funÃ§Ãµes, quando necessÃ¡rio.
function getDb() {
  return require('../config/firebase').getDb();
}

// âœ… FIX #10 (melhoria): parseFinanceMessage movido para o topo junto com os demais requires.
const { parseFinanceMessage } = require('../utils/parseFinanceMessage');

const { processVoiceMessage } = require('../services/audioService');
const twilio = require('twilio');
const { sendMessage, parseIncomingMessage } = require('../services/whatsappService');
const { buildFirestoreFilters, normalizeCategory, getPeriodLabel } = require('../parsers/intentParser');
const { formatCurrencyBR, getMonthRange, getCurrentMonthNameBR } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// UTILS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * âœ… FIX #4: escapa caracteres reservados do XML antes de inserir no <Message>.
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MAIN WEBHOOK HANDLER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /webhook
 * Entry point for all incoming WhatsApp messages
 */
async function handleWebhook(req, res) {
  try {
    // âœ… FIX: validaÃ§Ã£o de assinatura Twilio com URL correta para reverse proxy.
    //
    //    PROBLEMA ANTERIOR:
    //      validateTwilioSignature(req) usava req.protocol (retorna 'http' no Render)
    //      mas o Twilio sempre assina com 'https://finny-bot.onrender.com/webhook'.
    //      Resultado: HMAC nunca batia â†’ 403 em TODAS as mensagens.
    //
    //    SOLUÃ‡ÃƒO:
    //      1. Usa WEBHOOK_URL do env (fonte da verdade, sem ambiguidade).
    //      2. Se nÃ£o estiver definido, reconstrÃ³i com X-Forwarded-Proto/Host
    //         (headers injetados pelo reverse proxy do Render).
    //      3. Em desenvolvimento (NODE_ENV=development), pula a validaÃ§Ã£o.
    //
    //    ENV NECESSÃRIA no Render:
    //      WEBHOOK_URL = https://finny-bot.onrender.com/webhook
    if (PROVIDER === 'twilio') {
      const isDev = process.env.NODE_ENV === 'development';
      if (!isDev) {
        const authToken      = process.env.TWILIO_AUTH_TOKEN;
        const twilioSig      = req.headers['x-twilio-signature'] || '';

        // ReconstrÃ³i a URL pÃºblica â€” prioridade: env > forwarded headers > fallback
        const webhookUrl =
          process.env.WEBHOOK_URL ||
          `${req.headers['x-forwarded-proto'] || 'https'}://${
            req.headers['x-forwarded-host'] || req.headers['host']
          }${req.originalUrl}`;

        const isValid = twilio.validateRequest(
          authToken,
          twilioSig,
          webhookUrl,
          req.body ?? {}
        );

        if (!isValid) {
          logger.warn('Twilio signature validation failed', { webhookUrl, twilioSig: twilioSig.slice(0, 10) + '...' });
          return res.status(403).send('Forbidden');
        }
      }
    }

    const message = parseIncomingMessage(req.body, PROVIDER);

    // âœ… FIX #3: `message.userId` pode conter o prefixo "whatsapp:+55..." ou estar ausente.
    //    Usa `message.from` como fallback e sanitiza o nÃºmero antes de qualquer consulta.
    const rawPhone = message.from || message.userId || '';
    const phone = rawPhone.replace(/^whatsapp:/i, '').replace(/\D/g, '');

    if (!phone) {
      logger.warn('handleWebhook: nÃºmero de telefone ausente na mensagem recebida', message);
      return sendTwiml(res, 'âŒ NÃ£o foi possÃ­vel identificar seu nÃºmero. Tente novamente.');
    }

    // âœ… FIX #3 (cont.): consulta usando o nÃºmero sanitizado
    const db = getDb();
    const userSnapshot = await db
      .collection('users')
      .where('phone', '==', phone)
      .get();

    if (userSnapshot.empty) {
      return sendTwiml(
        res,
        'ðŸ”’ VocÃª precisa conectar sua conta.\n\nEntre no site e cadastre seu nÃºmero de telefone.'
      );
    }

    const userId = userSnapshot.docs[0].id;

    // âœ… FIX #3 (cont.): getOrCreateUser ainda Ã© Ãºtil para atualizar `lastSeenAt`,
    //    mas nÃ£o precisamos do retorno â€” o userId jÃ¡ foi obtido acima.
    await getOrCreateUser(userId);

    const text = (message.text || message.body || '').toLowerCase().trim();

    // â”€â”€ SaudaÃ§Ã£o â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text.includes('oi') || text.includes('ola') || text.includes('olÃ¡')) {
      return sendTwiml(
        res,
        'OlÃ¡! ðŸ‘‹ Sou o FinnyBot.\n\nMe diga algo como:\nâ€¢ "gastei 50"\nâ€¢ "ganhei 1000"\nâ€¢ "saldo"'
      );
    }

    // â”€â”€ Saldo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text.includes('saldo')) {
      const { start, end } = getMonthRange();
      const summary = await getTransactionSummary(userId, start, end);

      const fmt = (v) => formatCurrencyBR(Number(v || 0));
      const saldoEmoji = summary.balance >= 0 ? 'ðŸ˜Š' : 'âš ï¸';

      return sendTwiml(
        res,
        `ðŸ’° *Resumo do mÃªs*\n\nReceitas: ${fmt(summary.totalIncome)}\nGastos: ${fmt(summary.totalExpenses)}\nSaldo: ${fmt(summary.balance)} ${saldoEmoji}`
      );
    }

    // â”€â”€ AnÃ¡lise â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text.includes('analise') || text.includes('anÃ¡lise')) {
      const { start, end } = getMonthRange();
      const summary    = await getTransactionSummary(userId, start, end);
      const comparison = await getMonthComparison(userId);

      const fmt = (v) => formatCurrencyBR(Number(v || 0));
      let reply = `ðŸ“Š *AnÃ¡lise do mÃªs*\n\n`;
      reply += `ðŸ’¸ Total gasto: ${fmt(summary.totalExpenses)}\n`;

      if (summary.topCategory) {
        const [cat, value] = summary.topCategory;
        reply += `ðŸ† Maior gasto: ${cat} â€” ${fmt(value)}\n`;
      }

      if (comparison.expenseDiff !== null) {
        const diff = Math.abs(comparison.expenseDiff).toFixed(0);
        reply +=
          comparison.expenseDiff > 0
            ? `âš ï¸ Seus gastos aumentaram ${diff}% em relaÃ§Ã£o ao mÃªs passado\n`
            : `âœ… Seus gastos diminuÃ­ram ${diff}% em relaÃ§Ã£o ao mÃªs passado\n`;
      }

      if (summary.topCategory) {
        reply += `\nðŸ’¡ Dica: tente reduzir gastos com *${summary.topCategory[0]}*`;
      }

      return sendTwiml(res, reply);
    }

    // â”€â”€ Fallback: tenta interpretar como lanÃ§amento financeiro â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const parsed = await parseFinanceMessage(text, userId);

    let reply =
      'NÃ£o entendi ðŸ¤”\n\nTente algo como:\nâ€¢ "gastei 50"\nâ€¢ "ganhei 1000"\nâ€¢ "saldo"';

    if (parsed.type === 'expense' || parsed.type === 'income') {
      logger.info('Parsed finance message:', parsed);

      await saveTransaction(userId, {
        type:        parsed.type,
        amount:      parsed.amount,
        description: parsed.originalText || parsed.category,
        category:    parsed.category,
      });

      const emoji = parsed.type === 'income' ? 'ðŸ’°' : 'ðŸ’¸';
      const label = parsed.type === 'income' ? 'Receita' : 'Gasto';
      const fmt   = (v) => formatCurrencyBR(Number(v || 0));

      reply = `${emoji} ${label} registrada!\n${fmt(parsed.amount)} - ${parsed.category}`;

      if (parsed.type === 'expense') {
        const { start, end } = getMonthRange();
        const summary        = await getTransactionSummary(userId, start, end);
        const totalCategory  = summary.byCategory?.[parsed.category] || 0;

        reply += `\n\nðŸ“Š Total com ${parsed.category} este mÃªs: ${fmt(totalCategory)}`;

        if (summary.balance < 0) {
          reply += `\nâš ï¸ VocÃª estÃ¡ com saldo negativo`;
        }

        const alertMsg = await sendSmartAlerts(userId);
        if (alertMsg) {
          reply += `\n\nðŸš¨ *AtenÃ§Ã£o:*\n${alertMsg}`;
        }
      }
    }

    // ðŸ§  Aprendizado automÃ¡tico
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

    // âœ… FIX #4 (aplicado tambÃ©m no catch): usa sendTwiml para garantir XML vÃ¡lido
    return sendTwiml(res, 'Erro ðŸ˜•');
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// MESSAGE PROCESSING PIPELINE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * âœ… FIX #1: funÃ§Ã£o `processMessage` restaurada como async function completa.
 *    O bloco `/* ... *\/` original fechava apenas os Steps 1-2, fazendo com que
 *    os Steps 3-7 ficassem FORA de qualquer funÃ§Ã£o â€” cÃ³digo Ã³rfÃ£o no nÃ­vel
 *    do mÃ³dulo, causando SyntaxError / ReferenceError no boot do servidor.
 */
async function processMessage(message) {
  const { from, type } = message;
  const userId = (from || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  let text = message.text;

  // â”€â”€ Step 1: Ensure user exists â”€â”€
  await getOrCreateUser(from);

  // â”€â”€ Step 2: Handle audio messages â”€â”€
  if (type === 'audio' && message.mediaUrl) {
    const result = await processVoiceMessage(message.mediaUrl, PROVIDER);
    if (!result.success || !result.text) {
      await sendMessage(from, 'ðŸŽ¤ NÃ£o consegui entender o Ã¡udio. Pode escrever sua mensagem?');
      return;
    }
    text = result.text;
    logger.info(`Transcription from ${userId}: "${text}"`);
  }

  if (!text || text.trim().length === 0) {
    await sendMessage(from, 'Oi! Pode me enviar uma mensagem de texto ou Ã¡udio. ðŸ˜Š');
    return;
  }

  // â”€â”€ Step 3: Load conversation history â”€â”€
  const history = await getConversationHistory(userId);
  const historyMessages = history.map((m) => ({ role: m.role, content: m.content }));

  // â”€â”€ Step 4: Detect intent â”€â”€
  const intent = await parseIntent(text, historyMessages);
  logger.info(`Intent: ${JSON.stringify(intent)}`);

  // â”€â”€ Step 5: Save user message to history â”€â”€
  await saveConversationMessage(userId, 'user', text);

  // â”€â”€ Step 6: Route to handler â”€â”€
  let reply;
  try {
    reply = await routeIntent(intent, text, userId, from, historyMessages);
  } catch (err) {
    logger.error(`Intent routing error (${intent.intent}):`, err);
    reply = 'ðŸ˜• Tive um problema ao processar sua solicitaÃ§Ã£o. Pode tentar novamente?';
  }

  // â”€â”€ Step 7: Send reply â”€â”€
  if (reply) {
    await sendMessage(from, reply);
    await saveConversationMessage(userId, 'assistant', reply);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// INTENT ROUTER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        return intent.clarification_question || 'NÃ£o entendi bem. Pode reformular? ðŸ˜Š';
      }
      return handleUnknown(rawText, historyMessages);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HANDLERS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleCreateTransaction(intent, rawText, userId, historyMessages) {
  const transactions = intent.transactions || [];

  if (transactions.length === 0) {
    return await generateResponse(rawText, { error: 'no_transaction_found' }, historyMessages);
  }

  const tx = transactions[0];

  if (!tx.amount || tx.amount <= 0) {
    return 'NÃ£o consegui identificar o valor. Pode repetir? Ex: "gastei 50 no mercado"';
  }

  await saveTransaction(userId, tx);

  const typeLabel = tx.type === 'income' ? 'receita' : 'gasto';
  const emoji     = tx.type === 'income' ? 'ðŸ’°' : 'ðŸ’¸';

  return `${emoji} ${capitalize(typeLabel)} registrado!\n*${tx.description}*\nValor: ${formatCurrencyBR(tx.amount)}\nCategoria: ${tx.category}`;
}

async function handleMultipleTransactions(intent, rawText, userId, historyMessages) {
  const transactions = intent.transactions || [];

  if (transactions.length === 0) {
    return await generateResponse(rawText, { error: 'no_transactions_found' }, historyMessages);
  }

  const saved = await saveTransactionsBatch(userId, transactions);

  const lines = saved.map((tx) => {
    const emoji = tx.type === 'income' ? 'ðŸ’°' : 'ðŸ’¸';
    return `${emoji} ${tx.description}: ${formatCurrencyBR(tx.amount)}`;
  });

  return `âœ… ${saved.length} transaÃ§Ãµes registradas:\n${lines.join('\n')}`;
}

async function handleQueryExpenses(intent, userId, rawText, historyMessages) {
  const filters  = buildFirestoreFilters({ ...intent.filters, type: 'expense' });
  const summary  = await getTransactionSummary(userId, filters.startDate, filters.endDate);
  const period   = intent.filters?.period || 'month';
  const periodLabel = getPeriodLabel(period);

  if (summary.totalExpenses === 0) {
    return `VocÃª nÃ£o tem gastos registrados ${periodLabel}. ðŸŽ‰`;
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
    return `VocÃª nÃ£o tem receitas registradas ${periodLabel}.`;
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
  const emoji          = summary.balance >= 0 ? 'ðŸ˜Š' : 'ðŸ˜Ÿ';

  return `${emoji} *Saldo de ${month}:*\nðŸ’° Receitas: ${formatCurrencyBR(summary.totalIncome)}\nðŸ’¸ Gastos: ${formatCurrencyBR(summary.totalExpenses)}\nðŸ“Š Saldo: ${formatCurrencyBR(summary.balance)}`;
}

async function handleQueryCategory(intent, userId, rawText, historyMessages) {
  const category     = normalizeCategory(intent.filters?.category);
  const filters      = buildFirestoreFilters({ ...intent.filters, type: 'expense', category });
  const transactions = await queryTransactions(userId, filters);
  const total        = transactions.reduce((s, t) => s + t.amount, 0);
  const period       = intent.filters?.period || 'month';
  const periodLabel  = getPeriodLabel(period);

  if (!category || total === 0) {
    return `VocÃª nÃ£o tem gastos em ${category || 'essa categoria'} ${periodLabel}.`;
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
  let greeting = 'OlÃ¡';
  if (hour < 12)       greeting = 'Bom dia';
  else if (hour < 18)  greeting = 'Boa tarde';
  else                 greeting = 'Boa noite';

  const isFirstTime = (historyMessages || []).length <= 2;

  if (isFirstTime) {
    return `${greeting}! ðŸ‘‹ Sou o *Finny*, seu assistente financeiro pessoal.\n\nPosso te ajudar a:\nðŸ’¸ Registrar gastos e receitas\nðŸ“Š Ver resumos do mÃªs\nðŸŽ¯ Acompanhar metas\n\nExperimente: _"gastei 50 no mercado"_ ou _"quanto gastei esse mÃªs?"_`;
  }

  return `${greeting}! ðŸ˜Š Como posso te ajudar hoje?`;
}

async function handleSetGoal(intent, userId, rawText, historyMessages) {
  return await generateResponse(rawText, { note: 'goal_setting_in_development' }, historyMessages);
}

async function handleCheckGoals(userId) {
  const goals = await getUserGoals(userId);

  if (goals.length === 0) {
    return 'VocÃª ainda nÃ£o tem metas configuradas. Para criar uma, diga algo como: "quero gastar no mÃ¡ximo R$500 com alimentaÃ§Ã£o esse mÃªs".';
  }

  const { start, end } = getMonthRange();
  const summary        = await getTransactionSummary(userId, start, end);
  const alerts         = await generateGoalAlerts(goals, summary);

  if (alerts.length === 0) {
    return 'âœ… Todas as suas metas estÃ£o dentro do limite!';
  }

  return alerts.map((a) => a.message).join('\n');
}

function handleHelp() {
  return `ðŸ¤– *Finny â€” Seu Assistente Financeiro*

*Registrar gastos:*
â€¢ "gastei 50 no mercado"
â€¢ "paguei 30 de uber"
â€¢ "foi 25 no ifood"

*Registrar receitas:*
â€¢ "recebi 1200 de salÃ¡rio"
â€¢ "entrou 500 de freela"

*Consultar gastos:*
â€¢ "quanto gastei esse mÃªs?"
â€¢ "quanto foi com alimentaÃ§Ã£o?"
â€¢ "gastos dessa semana"

*Resumo:*
â€¢ "resumo do mÃªs"
â€¢ "como estÃ£o minhas finanÃ§as?"

*Saldo:*
â€¢ "qual meu saldo?"
â€¢ "quanto tenho disponÃ­vel?"`;
}

async function handleUnknown(rawText, historyMessages) {
  return await generateResponse(rawText, { context: 'unknown_intent' }, historyMessages);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SMART ALERTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HEALTH CHECK
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleHealthCheck(req, res) {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    provider:  PROVIDER,
    version:   process.env.npm_package_version || '1.0.0',
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// EXPORTS
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

module.exports = { handleWebhook, handleHealthCheck };
