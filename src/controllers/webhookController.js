
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

// getDb() é lazy — chamado apenas dentro das funções, quando necessário.
function getDb() {
  return require('../config/firebase').getDb();
}

const { parseFinanceMessage } = require('../utils/parseFinanceMessage');
const { processVoiceMessage } = require('../services/audioService');
const twilio = require('twilio');
const { sendMessage, parseIncomingMessage } = require('../services/whatsappService');
const { buildFirestoreFilters, normalizeCategory, getPeriodLabel } = require('../parsers/intentParser');
const { formatCurrencyBR, getMonthRange, getCurrentMonthNameBR } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio';

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sendTwiml(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${escapeXml(message)}</Message></Response>`);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Normaliza o número de telefone para o formato padrão do sistema:
 * 11 dígitos — DDD (2) + 9 + número (8) — sem código do país.
 *
 * Exemplos de entrada → saída:
 *   "whatsapp:+5531998985332" → "31998985332"  (13 dígitos com 55)
 *   "whatsapp:+55319 8985332" → "31998985332"  (12 dígitos, formato antigo sem o 9)
 *   "31998985332"             → "31998985332"  (já no formato correto)
 */
function normalizePhone(rawPhone) {
  // Remove prefixo whatsapp: e qualquer caractere não-numérico
  let phone = String(rawPhone || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');

  // Remove o código do país 55 se presente
  if (phone.startsWith('55') && phone.length >= 12) {
    phone = phone.slice(2);
  }

  // Formato antigo (8 dígitos após DDD, sem o 9): insere o 9 após o DDD
  // Ex: 3198985332 (10 dígitos) → 31998985332 (11 dígitos)
  if (phone.length === 10) {
    phone = phone.slice(0, 2) + '9' + phone.slice(2);
  }

  return phone;
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
    // ── Validação de assinatura Twilio ────────────────────────────────────────
    if (PROVIDER === 'twilio') {
      const isDev     = process.env.NODE_ENV === 'development';
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (!authToken) {
        logger.warn('⚠️  TWILIO_AUTH_TOKEN não configurado — validação de assinatura desativada!');
      } else if (!isDev) {
        const twilioSig  = req.headers['x-twilio-signature'] || '';
        const webhookUrl =
          process.env.WEBHOOK_URL ||
          `${req.headers['x-forwarded-proto'] || 'https'}://${
            req.headers['x-forwarded-host'] || req.headers['host']
          }${req.originalUrl}`;

        const isValid = twilio.validateRequest(authToken, twilioSig, webhookUrl, req.body ?? {});

        if (!isValid) {
          logger.warn('Twilio signature validation failed', {
            webhookUrl,
            twilioSig: twilioSig.slice(0, 10) + '...',
          });
          return res.status(403).send('Forbidden');
        }
      }
    }

    // ── Identifica o número do usuário ────────────────────────────────────────
    const message  = parseIncomingMessage(req.body, PROVIDER);
    const rawPhone = message.from || message.userId || '';
    const phone    = normalizePhone(rawPhone);

    if (!phone || phone.length < 10) {
      logger.warn('handleWebhook: número inválido ou ausente', { rawPhone, phone });
      return sendTwiml(res, '❌ Não foi possível identificar seu número. Tente novamente.');
    }

    logger.info(`Mensagem recebida de: ${phone}`);

    // ── Busca usuário no Firestore ────────────────────────────────────────────
    const db           = getDb();
    const userSnapshot = await db
      .collection('users')
      .where('phoneNumber', '==', phone)
      .get();

    if (userSnapshot.empty) {
      logger.warn(`Usuário não encontrado para o número: ${phone}`);
      return sendTwiml(
        res,
        '🔒 Você precisa conectar sua conta.\n\nAcesse o site Allo Finanças e cadastre seu número de telefone (apenas DDD + número, sem o 55).'
      );
    }

    const userId = userSnapshot.docs[0].id;

    // Atualiza lastSeenAt sem bloquear o fluxo em caso de erro
    getOrCreateUser(userId).catch((err) =>
      logger.warn('Falha ao atualizar lastSeenAt: ' + err.message)
    );

    const text = (message.text || message.body || '').toLowerCase().trim();

    if (!text) {
      return sendTwiml(res, 'Olá! Envie uma mensagem de texto para começar. 😊');
    }

    // ── Saudação ──────────────────────────────────────────────────────────────
    if (/\b(oi|ol[aá]|hey|e a[ií]|bom dia|boa tarde|boa noite)\b/.test(text)) {
      const hour = new Date().getHours();
      let greeting = 'Olá';
      if (hour < 12)      greeting = 'Bom dia';
      else if (hour < 18) greeting = 'Boa tarde';
      else                greeting = 'Boa noite';

      return sendTwiml(
        res,
        `${greeting}! 👋 Sou o *Finny*, seu assistente financeiro.\n\nMe diga algo como:\n• "gastei 50 no mercado"\n• "ganhei 1000 de salário"\n• "saldo"\n• "análise"`
      );
    }

    // ── Ajuda ─────────────────────────────────────────────────────────────────
    if (text.includes('ajuda') || text.includes('help') || text === '?') {
      return sendTwiml(res, handleHelp());
    }

    // ── Saldo ─────────────────────────────────────────────────────────────────
    if (text.includes('saldo')) {
      const { start, end } = getMonthRange();
      const summary        = await getTransactionSummary(userId, start, end);
      const fmt            = (v) => formatCurrencyBR(Number(v || 0));
      const saldoEmoji     = summary.balance >= 0 ? '😊' : '⚠️';

      return sendTwiml(
        res,
        `💰 *Resumo do mês*\n\nReceitas: ${fmt(summary.totalIncome)}\nGastos: ${fmt(summary.totalExpenses)}\nSaldo: ${fmt(summary.balance)} ${saldoEmoji}`
      );
    }

    // ── Análise ───────────────────────────────────────────────────────────────
    if (text.includes('analise') || text.includes('análise') || text.includes('análise')) {
      const { start, end } = getMonthRange();
      const summary        = await getTransactionSummary(userId, start, end);
      const comparison     = await getMonthComparison(userId);
      const fmt            = (v) => formatCurrencyBR(Number(v || 0));

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

    // ── Consultas avançadas (integradas ao routeIntent) ─────────────────────────
const queryKeywords = [
  'quanto gastei', 'quanto ganhei', 'quanto recebi', 'gastos', 'receitas',
  'histórico', 'historico', 'alimentação', 'transporte', 'mercado', 'saúde',
  'semana', 'mês passado', 'mes passado', 'hoje', 'ontem', 'última semana',
  'categoria', 'resumo', 'extrato', 'lista', 'mostre', 'mostra', 'ver',
];

if (queryKeywords.some((kw) => text.includes(kw))) {
  try {
    const { parseIntent } = require('../services/aiService');
    const intent = await parseIntent(text, []);
    const replyFromIntent = await routeIntent(intent, text, userId, null, []);
    return sendTwiml(res, replyFromIntent || 'Não encontrei informações para essa consulta.');
  } catch (queryErr) {
    logger.warn('Erro ao rotear consulta: ' + queryErr.message);
    // Continua para o fallback normal
  }
}

    // ── Fallback: tenta interpretar como lançamento financeiro ────────────────
    let parsed;
    try {
      parsed = await parseFinanceMessage(text, userId);
    } catch (parseErr) {
      logger.error('Erro ao parsear mensagem financeira: ' + parseErr.message);
      parsed = {};
    }

    let reply = 'Não entendi 🤔\n\nTente algo como:\n• "gastei 50"\n• "ganhei 1000"\n• "saldo"\n• "ajuda"';

    if (parsed && (parsed.type === 'expense' || parsed.type === 'income')) {
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

      reply = `${emoji} *${label} registrada!*\n${fmt(parsed.amount)} — ${parsed.category}`;

      if (parsed.type === 'expense') {
        try {
          const { start, end } = getMonthRange();
          const summary        = await getTransactionSummary(userId, start, end);
          const totalCategory  = summary.byCategory?.[parsed.category] || 0;

          reply += `\n\n📊 Total com *${parsed.category}* este mês: ${fmt(totalCategory)}`;

          if (summary.balance < 0) {
            reply += `\n⚠️ Você está com saldo negativo`;
          }

          const alertMsg = await sendSmartAlerts(userId);
          if (alertMsg) {
            reply += `\n\n🚨 *Atenção:*\n${alertMsg}`;
          }
        } catch (summaryErr) {
          logger.warn('Erro ao buscar resumo pós-transação: ' + summaryErr.message);
        }
      }

      // 🧠 Aprendizado automático
      if (parsed.originalText && parsed.category) {
        db.collection('users')
          .doc(userId)
          .collection('learning')
          .doc(parsed.originalText)
          .set({ keyword: parsed.originalText, category: parsed.category })
          .catch((err) => logger.warn('Erro ao salvar aprendizado: ' + err.message));
      }
    }

    return sendTwiml(res, reply);

  } catch (error) {
    logger.error('handleWebhook error: ' + error.message);
    logger.error(error.stack ?? String(error));
    return sendTwiml(res, 'Desculpe, tive um problema interno. Tente novamente em instantes. 😕');
  }
}

// ─────────────────────────────────────────────
// REGISTRO DE USUÁRIO (chamado pelo site)
// ─────────────────────────────────────────────

/**
 * POST /register
 * Recebe { userId, phoneNumber } do site Allo Finanças,
 * atualiza o phoneNumber no Firestore e envia mensagem de boas-vindas via WhatsApp.
 *
 * O site deve chamar este endpoint após o usuário cadastrar o número.
 * phoneNumber deve ser enviado SEM o 55 — apenas DDD + 9 + número (11 dígitos).
 */
async function handleRegisterUser(req, res) {
  try {
    const { userId, phoneNumber } = req.body || {};

    if (!userId || !phoneNumber) {
      return res.status(400).json({ error: 'userId e phoneNumber são obrigatórios.' });
    }

    // Normaliza o número recebido do site
    const phone = normalizePhone(phoneNumber);

    if (phone.length !== 11) {
      return res.status(400).json({
        error: 'Número inválido. Use apenas DDD + 9 + número (11 dígitos, sem o 55).',
        recebido: phone,
      });
    }

    // Verifica se já existe outro usuário com esse número
    const db            = getDb();
    const existing      = await db.collection('users').where('phoneNumber', '==', phone).get();
    const alreadyExists = !existing.empty && existing.docs[0].id !== userId;

    if (alreadyExists) {
      return res.status(409).json({ error: 'Esse número já está vinculado a outra conta.' });
    }

    // Salva o número no documento do usuário
    await db.collection('users').doc(userId).set(
      { phoneNumber: phone, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    logger.info(`Usuário ${userId} registrou o número ${phone}`);

    // Envia mensagem de boas-vindas via WhatsApp
    const welcomeMessage =
      `👋 Olá! Sou o *Finny*, seu assistente financeiro pessoal da *Allo Finanças*! 🎉\n\n` +
      `Sua conta está conectada com sucesso! ✅\n\n` +
      `Agora você pode me enviar mensagens como:\n` +
      `• _"gastei 50 no mercado"_\n` +
      `• _"recebi 1200 de salário"_\n` +
      `• _"qual meu saldo?"_\n` +
      `• _"análise"_\n\n` +
      `Estou aqui para te ajudar a organizar suas finanças! 💚`;

    try {
      const whatsappNumber = `+55${phone}`;
      await sendMessage(whatsappNumber, welcomeMessage);
      logger.info(`Mensagem de boas-vindas enviada para ${whatsappNumber}`);
    } catch (msgErr) {
      // Não falha o registro se a mensagem não for enviada
      logger.warn('Falha ao enviar mensagem de boas-vindas: ' + msgErr.message);
    }

    return res.status(200).json({ success: true, message: 'Número registrado e mensagem enviada.' });

  } catch (error) {
    logger.error('handleRegisterUser error: ' + error.message);
    logger.error(error.stack ?? String(error));
    return res.status(500).json({ error: 'Erro interno ao registrar usuário.' });
  }
}

// ─────────────────────────────────────────────
// MESSAGE PROCESSING PIPELINE
// ─────────────────────────────────────────────

async function processMessage(message) {
  const { from, type } = message;
  const userId = normalizePhone(from || '');
  let text = message.text;

  await getOrCreateUser(from);

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

  const history         = await getConversationHistory(userId);
  const historyMessages = history.map((m) => ({ role: m.role, content: m.content }));

  const intent = await parseIntent(text, historyMessages);
  logger.info(`Intent: ${JSON.stringify(intent)}`);

  await saveConversationMessage(userId, 'user', text);

  let reply;
  try {
    reply = await routeIntent(intent, text, userId, from, historyMessages);
  } catch (err) {
    logger.error(`Intent routing error (${intent.intent}):`, err);
    reply = '😕 Tive um problema ao processar sua solicitação. Pode tentar novamente?';
  }

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
  const filters     = buildFirestoreFilters({ ...intent.filters, type: 'expense' });
  const summary     = await getTransactionSummary(userId, filters.startDate, filters.endDate);
  const period      = intent.filters?.period || 'month';
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
  if (hour < 12)      greeting = 'Bom dia';
  else if (hour < 18) greeting = 'Boa tarde';
  else                greeting = 'Boa noite';
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

module.exports = { handleWebhook, handleRegisterUser, handleHealthCheck };
