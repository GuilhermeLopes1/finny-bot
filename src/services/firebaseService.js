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
    // Update last seen
    await userRef.update({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
    return { id: userId, ...userSnap.data() };
  }

  // Create new user
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

/**
 * Save multiple transactions in a batch
 */
async function saveTransaction(userId, transaction) {
  const db = getDb();
  const admin = require('firebase-admin');

  const userRef = db.collection(COLLECTIONS.USERS).doc(userId);

  const txData = {
    id: Date.now().toString(),
    type: transaction.type,
    amount: parseFloat(transaction.amount),
    description: transaction.description || '',
    category: transaction.category || 'outros',
    date: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    source: 'whatsapp'
  };

  // 🔥 PEGA DADOS ATUAIS
  const doc = await userRef.get();
  const current = doc.data() || {};

  const transactions = current.transactions || [];

  // 🔥 ADICIONA NOVA
  transactions.push(txData);

  // 🔥 SALVA ARRAY COMPLETO (FORÇA UPDATE)
  await userRef.set({
    transactions: transactions
  }, { merge: true });

  console.log("✅ FORÇANDO atualização pro front");

  return txData;
}

/**
 * Query transactions with flexible filters
 */
async function queryTransactions(userId, filters = {}) {
  const db = getDb();

  const userDoc = await db.collection('users').doc(userId).get();
  const data = userDoc.data() || {};

  let transactions = data.transactions || [];

  // filtro por tipo
  if (filters.type) {
    transactions = transactions.filter(t => t.type === filters.type);
  }

  // filtro por categoria
  if (filters.category) {
    transactions = transactions.filter(t => t.category === filters.category);
  }

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

  // Sort categories by spending
  summary.topCategory = Object.entries(summary.byCategory).sort(([, a], [, b]) => b - a)[0];

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

/**
 * Load the last N messages for a user (for AI context)
 */
async function getConversationHistory(userId, limit = 10) {
  const db = getDb();
  const snapshot = await db
    .collection(COLLECTIONS.CONVERSATIONS)
    .doc(userId)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  const messages = snapshot.docs.map((doc) => doc.data()).reverse();
  return messages;
}

/**
 * Append messages to conversation history
 */
async function saveConversationMessage(userId, role, content) {
  const db = getDb();
  const msgRef = db
    .collection(COLLECTIONS.CONVERSATIONS)
    .doc(userId)
    .collection('messages')
    .doc();

  await msgRef.set({
    role, // 'user' | 'assistant'
    content,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Keep only last 50 messages (cleanup old ones async)
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

/**
 * Get user goals/budgets
 */
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

/**
 * Save a goal
 */
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
