
/**
 * Firebase Firestore Service
 * All database operations for users, transactions, and conversation history
 */

const { getDb, admin } = require('../config/firebase');
const { getMonthRange, getLastMonthRange } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const COLLECTIONS = {
  USERS: 'users',
  TRANSACTIONS: 'transactions',
  CONVERSATIONS: 'conversations',
  GOALS: 'goals',
};

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

/**
 * Get or create user by phone number
 */
async function getOrCreateUser(phoneNumber) {
  const db = getDb();
  const userId = sanitizePhoneNumber(phoneNumber);
  const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
  const userSnap = await userRef.get();

  if (userSnap.exists) {
    await userRef.update({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
    return { id: userId, ...userSnap.data() };
  }

  const newUser = {
    phoneNumber,
    userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    preferences: {
      currency: 'BRL',
      language: 'pt-BR',
      timezone: 'America/Sao_Paulo',
    },
    stats: {
      totalTransactions: 0,
    },
  };

  await userRef.set(newUser);
  logger.info(`New user created: ${userId}`);
  return { id: userId, ...newUser };
}

/**
 * Update user profile
 */
async function updateUser(userId, data) {
  const db = getDb();
  await db.collection(COLLECTIONS.USERS).doc(userId).update({
    ...data,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ─────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────

/**
 * Save a single transaction to the user's transactions array
 */
async function saveTransaction(userId, transaction) {
  const db = getDb();
  const userRef = db.collection(COLLECTIONS.USERS).doc(userId);

  // ✅ FIX: store date as ISO string consistently
  const now = new Date();
  const txData = {
    id: Date.now().toString(),
    type: transaction.type,
    amount: parseFloat(transaction.amount),
    description: transaction.description || '',
    category: transaction.category || 'outros',
    date: now.toISOString(),       // always ISO string
    createdAt: now.toISOString(),  // always ISO string
    source: 'whatsapp',
  };

  const doc = await userRef.get();
  const current = doc.data() || {};
  const transactions = current.transactions || [];

  transactions.push(txData);

  await userRef.set({ transactions }, { merge: true });

  console.log('✅ Transação salva:', txData);
  return txData;
}

/**
 * Save multiple transactions in a batch
 */
async function saveTransactionsBatch(userId, transactionList) {
  const db = getDb();
  const userRef = db.collection(COLLECTIONS.USERS).doc(userId);

  const now = new Date();
  const newTxs = transactionList.map((t, i) => ({
    id: (Date.now() + i).toString(),
    type: t.type,
    amount: parseFloat(t.amount),
    description: t.description || '',
    category: t.category || 'outros',
    date: now.toISOString(),
    createdAt: now.toISOString(),
    source: 'whatsapp',
  }));

  const doc = await userRef.get();
  const current = doc.data() || {};
  const transactions = [...(current.transactions || []), ...newTxs];

  await userRef.set({ transactions }, { merge: true });

  console.log(`✅ ${newTxs.length} transações salvas em batch`);
  return newTxs;
}

/**
 * Query transactions with flexible filters
 * ✅ FIX: all date comparisons use numeric timestamps to avoid
 *    silent failures when mixing Date objects, Firestore Timestamps,
 *    or ISO strings.
 */
async function queryTransactions(userId, filters = {}) {
  const db = getDb();

  const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
  const data = userDoc.data() || {};
  let transactions = data.transactions || [];

  console.log(`🔍 queryTransactions | userId=${userId} | total no doc=${transactions.length} | filters=`, filters);

  // filter by type
  if (filters.type) {
    transactions = transactions.filter(t => t.type === filters.type);
  }

  // filter by category
  if (filters.category) {
    transactions = transactions.filter(t => t.category === filters.category);
  }

  // ✅ FIX: convert everything to ms timestamps before comparing
  if (filters.startDate || filters.endDate) {
    // Safely convert any date representation to ms timestamp
    const toMs = (d) => {
      if (!d) return null;
      if (typeof d === 'number') return d;
      if (d instanceof Date) return d.getTime();
      // Firestore Timestamp object
      if (typeof d.toDate === 'function') return d.toDate().getTime();
      // ISO string or any parseable string
      return new Date(d).getTime();
    };

    const startMs = toMs(filters.startDate);
    const endMs   = toMs(filters.endDate);

    transactions = transactions.filter(t => {
      // t.date is always stored as ISO string
      const txMs = new Date(t.date).getTime();

      if (isNaN(txMs)) {
        console.warn('⚠️ Transação com data inválida ignorada:', t);
        return false;
      }

      const afterStart = startMs !== null ? txMs >= startMs : true;
      const beforeEnd  = endMs   !== null ? txMs <= endMs   : true;
      return afterStart && beforeEnd;
    });
  }

  console.log(`🔍 Após filtros: ${transactions.length} transações`);
  return transactions;
}

/**
 * Get summarized stats for a period
 */
async function getTransactionSummary(userId, startDate, endDate) {
  const transactions = await queryTransactions(userId, { startDate, endDate });

  const summary = {
    totalIncome: 0,
    totalExpenses: 0,
    balance: 0,
    byCategory: {},
    transactionCount: transactions.length,
    transactions,
  };

  for (const tx of transactions) {
    if (tx.type === 'income') {
      summary.totalIncome += tx.amount;
    } else {
      summary.totalExpenses += tx.amount;
      summary.byCategory[tx.category] = (summary.byCategory[tx.category] || 0) + tx.amount;
    }
  }

  summary.balance = summary.totalIncome - summary.totalExpenses;
  summary.topCategory = Object.entries(summary.byCategory).sort(([, a], [, b]) => b - a)[0];

  console.log('📊 Summary:', {
    income: summary.totalIncome,
    expenses: summary.totalExpenses,
    balance: summary.balance,
    count: summary.transactionCount,
  });

  return summary;
}

/**
 * Compare current month vs last month
 */
async function getMonthComparison(userId) {
  const { start: thisStart, end: thisEnd } = getMonthRange();
  const { start: lastStart, end: lastEnd } = getLastMonthRange();

  const [thisMonth, lastMonth] = await Promise.all([
    getTransactionSummary(userId, thisStart, thisEnd),
    getTransactionSummary(userId, lastStart, lastEnd),
  ]);

  const expenseDiff =
    lastMonth.totalExpenses > 0
      ? ((thisMonth.totalExpenses - lastMonth.totalExpenses) / lastMonth.totalExpenses) * 100
      : null;

  return { thisMonth, lastMonth, expenseDiff };
}

/**
 * Get category spending comparison month over month
 */
async function getCategoryComparison(userId, category) {
  const { start: thisStart, end: thisEnd } = getMonthRange();
  const { start: lastStart, end: lastEnd } = getLastMonthRange();

  const [thisMonth, lastMonth] = await Promise.all([
    queryTransactions(userId, { startDate: thisStart, endDate: thisEnd, type: 'expense', category }),
    queryTransactions(userId, { startDate: lastStart, endDate: lastEnd, type: 'expense', category }),
  ]);

  const thisTotal = thisMonth.reduce((s, t) => s + t.amount, 0);
  const lastTotal = lastMonth.reduce((s, t) => s + t.amount, 0);
  const diff = lastTotal > 0 ? ((thisTotal - lastTotal) / lastTotal) * 100 : null;

  return { thisTotal, lastTotal, diff };
}

// ─────────────────────────────────────────────
// CONVERSATION HISTORY
// ─────────────────────────────────────────────

async function getConversationHistory(userId, limit = 10) {
  const db = getDb();
  const snapshot = await db
    .collection(COLLECTIONS.CONVERSATIONS)
    .doc(userId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => doc.data()).reverse();
}

async function saveConversationMessage(userId, role, content) {
  const db = getDb();
  const msgRef = db
    .collection(COLLECTIONS.CONVERSATIONS)
    .doc(userId)
    .collection('messages')
    .doc();

  await msgRef.set({
    role,
    content,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  cleanupOldMessages(userId).catch(() => {});
}

async function cleanupOldMessages(userId, keepLast = 50) {
  const db = getDb();
  const snapshot = await db
    .collection(COLLECTIONS.CONVERSATIONS)
    .doc(userId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .offset(keepLast)
    .limit(100)
    .get();

  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

// ─────────────────────────────────────────────
// GOALS / BUDGETS
// ─────────────────────────────────────────────

async function getUserGoals(userId) {
  const db = getDb();
  const snapshot = await db
    .collection(COLLECTIONS.USERS)
    .doc(userId)
    .collection(COLLECTIONS.GOALS)
    .where('active', '==', true)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function saveGoal(userId, goal) {
  const db = getDb();
  const goalRef = db
    .collection(COLLECTIONS.USERS)
    .doc(userId)
    .collection(COLLECTIONS.GOALS)
    .doc();

  await goalRef.set({
    ...goal,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { id: goalRef.id, ...goal };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function sanitizePhoneNumber(phone) {
  return phone.replace(/\D/g, '').replace(/^whatsapp:/, '');
}

module.exports = {
  getOrCreateUser,
  updateUser,
  saveTransaction,
  saveTransactionsBatch,
  queryTransactions,
  getTransactionSummary,
  getMonthComparison,
  getCategoryComparison,
  getConversationHistory,
  saveConversationMessage,
  getUserGoals,
  saveGoal,
  sanitizePhoneNumber,
};
