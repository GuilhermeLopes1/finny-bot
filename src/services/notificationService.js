const { hydrateProfile } = require('./v39ProfileService');
const crypto = require('crypto');
const { buildAccountsAndCards, asNumber } = require('./allofyTools');

function database() {
  return require('../config/firebase').getDb();
}

function pushClient() {
  return require('web-push');
}


function messagingClient() {
  return require('../config/firebase').admin.messaging();
}

function nativeDeviceEntries(profile = {}) {
  const devices = profile && typeof profile.fcmDevices === 'object' && !Array.isArray(profile.fcmDevices)
    ? profile.fcmDevices
    : {};
  return Object.entries(devices)
    .map(([installId, value]) => ({
      installId,
      token: String(value?.token || '').trim(),
      platform: String(value?.platform || 'android'),
    }))
    .filter(item => item.token.length >= 50 && item.token.length <= 4096 && !/\s/.test(item.token));
}

function hasNotificationTarget(profile = {}) {
  return nativeDeviceEntries(profile).length > 0 || Boolean(profile.pushSubscription);
}

function invalidFcmCode(code = '') {
  return [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ].includes(String(code));
}

async function clearInvalidNativeDevices(userId, profile = {}, invalidTokens = []) {
  if (!invalidTokens.length) return;
  const invalid = new Set(invalidTokens);
  const current = profile && typeof profile.fcmDevices === 'object' && !Array.isArray(profile.fcmDevices)
    ? profile.fcmDevices
    : {};
  const next = {};
  for (const [installId, value] of Object.entries(current)) {
    if (!invalid.has(String(value?.token || '').trim())) next[installId] = value;
  }
  await database().collection('users').doc(userId).set({
    fcmDevices: next,
    fcmUpdatedAt: new Date().toISOString(),
  }, { merge: true });
  profile.fcmDevices = next;
}

async function sendNativeToProfile(userId, profile, notification) {
  const entries = nativeDeviceEntries(profile);
  if (!entries.length) return false;

  const tokens = entries.slice(0, 500).map(item => item.token);
  const tag = String(notification.tag || 'allofinancas').slice(0, 120);
  const url = String(notification.url || '/app');
  const title = String(notification.title || 'Allo Finanças');
  const body = String(notification.body || '');

  const response = await messagingClient().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: {
      title,
      body,
      url,
      tag,
      source: 'allo-financas',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'allo_financas_alerts',
        icon: 'ic_notification_icon',
        color: '#6C63FF',
        sound: 'default',
        tag,
        clickAction: 'com.allofinancas.OPEN_NOTIFICATION',
      },
    },
  });

  const invalidTokens = [];
  response.responses.forEach((item, index) => {
    if (!item.success && invalidFcmCode(item.error?.code)) invalidTokens.push(tokens[index]);
  });
  if (invalidTokens.length) await clearInvalidNativeDevices(userId, profile, invalidTokens);

  return response.successCount > 0;
}

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: false,
  dailySummary: true,
  dailyTime: '08:00',
  billAlerts: true,
  cardAlerts: true,
  weeklySummary: true,
  inactivityReminder: false,
  supportMessages: true,
  aiUsageAlerts: true,
  timezone: 'America/Sao_Paulo',
});

function validTimeZone(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return DEFAULT_NOTIFICATION_PREFERENCES.timezone;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    return DEFAULT_NOTIFICATION_PREFERENCES.timezone;
  }
}

function validClock(value) {
  const candidate = String(value || '').trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate)
    ? candidate
    : DEFAULT_NOTIFICATION_PREFERENCES.dailyTime;
}

function normalizeNotificationPreferences(raw = {}) {
  return {
    enabled: raw.enabled === true,
    dailySummary: raw.dailySummary !== false,
    dailyTime: validClock(raw.dailyTime),
    billAlerts: raw.billAlerts !== false,
    cardAlerts: raw.cardAlerts !== false,
    weeklySummary: raw.weeklySummary !== false,
    inactivityReminder: raw.inactivityReminder === true,
    supportMessages: raw.supportMessages !== false,
    aiUsageAlerts: raw.aiUsageAlerts !== false,
    timezone: validTimeZone(raw.timezone),
  };
}

function localParts(now = new Date(), timeZone = DEFAULT_NOTIFICATION_PREFERENCES.timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour')) || 0;
  const minute = Number(get('minute')) || 0;
  const dateKey = `${year}-${month}-${day}`;
  const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return { year, month, day, hour, minute, dateKey, monthKey: `${year}-${month}`, weekday };
}

function minutesOf(clock) {
  const [hour, minute] = validClock(clock).split(':').map(Number);
  return hour * 60 + minute;
}

function notificationTimeReached(preferences, now = new Date()) {
  const local = localParts(now, preferences.timezone);
  return local.hour * 60 + local.minute >= minutesOf(preferences.dailyTime);
}

function money(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(asNumber(value));
}

function transactionIsoDate(item) {
  const raw = item?.date || item?.data || item?.createdAt;
  if (raw?.toDate) {
    const value = raw.toDate();
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const match = String(raw || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function cleanName(profile = {}) {
  return String(profile.name || profile.displayName || '').trim().split(/\s+/)[0] || 'Olá';
}

function currentMonthTotals(profile = {}, now = new Date()) {
  const parts = localParts(now, profile.notificationPreferences?.timezone);
  const transactions = Array.isArray(profile.transactions) ? profile.transactions : [];
  let income = 0;
  let expenses = 0;
  let pending = 0;

  for (const item of transactions) {
    if (!transactionIsoDate(item).startsWith(parts.monthKey)) continue;
    if (item?.benefitId) continue;
    const amount = Math.abs(asNumber(item?.amount ?? item?.value ?? item?.valor));
    const type = String(item?.type || item?.tipo || '').toLowerCase();
    const status = String(item?.status || 'paid').toLowerCase();
    const isPending = item?.pending === true || status.includes('pend');
    if (isPending) {
      if (['expense', 'despesa', 'saida', 'saída'].includes(type)) pending += amount;
      continue;
    }
    if (['income', 'receita', 'entrada'].includes(type)) income += amount;
    if (['expense', 'despesa', 'saida', 'saída'].includes(type)) expenses += amount;
  }

  return {
    income: Number(income.toFixed(2)),
    expenses: Number(expenses.toFixed(2)),
    balance: Number((income - expenses).toFixed(2)),
    pending: Number(pending.toFixed(2)),
  };
}

function sumBalances(items) {
  return Number((Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + asNumber(item?.balance ?? item?.saldo), 0
  ).toFixed(2));
}

function buildDailySummary(profile = {}, now = new Date()) {
  const totals = currentMonthTotals(profile, now);
  const accounts = buildAccountsAndCards(profile, now);
  const bankBalance = sumBalances(profile.banks);
  const firstName = cleanName(profile);
  const balanceSign = totals.balance >= 0 ? '+' : '-';

  return {
    title: `✨ Bom dia, ${firstName}! Seu dinheiro em um olhar`,
    body: `Saldo do mês: ${balanceSign}${money(Math.abs(totals.balance))} · Gastos: ${money(totals.expenses)} · Faturas abertas: ${money(accounts.totalInvoicesOpen)} · Bancos: ${money(bankBalance)}`,
    tag: 'daily-summary',
    url: '/app?action=open-dashboard&via=notification',
    details: { ...totals, totalInvoicesOpen: accounts.totalInvoicesOpen, bankBalance },
  };
}

function buildWeeklySummary(profile = {}, now = new Date()) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  const local = localParts(now, preferences.timezone);
  const currentDate = new Date(`${local.dateKey}T12:00:00Z`);
  const start = new Date(currentDate);
  start.setUTCDate(start.getUTCDate() - 6);
  const startKey = start.toISOString().slice(0, 10);
  const transactions = Array.isArray(profile.transactions) ? profile.transactions : [];
  let income = 0;
  let expenses = 0;

  for (const item of transactions) {
    const date = transactionIsoDate(item);
    if (!date || date < startKey || date > local.dateKey || item?.benefitId) continue;
    const status = String(item?.status || 'paid').toLowerCase();
    if (item?.pending === true || status.includes('pend')) continue;
    const amount = Math.abs(asNumber(item?.amount ?? item?.value ?? item?.valor));
    const type = String(item?.type || item?.tipo || '').toLowerCase();
    if (['income', 'receita', 'entrada'].includes(type)) income += amount;
    if (['expense', 'despesa', 'saida', 'saída'].includes(type)) expenses += amount;
  }

  const balance = income - expenses;
  return {
    title: '✨ Sua semana financeira está pronta',
    body: `Entradas: ${money(income)} · Saídas: ${money(expenses)} · Resultado: ${balance >= 0 ? '+' : '-'}${money(Math.abs(balance))}`,
    tag: 'weekly-summary',
    url: '/app?action=open-dashboard&via=notification',
  };
}

function daysBetweenDateKeys(fromKey, toKey) {
  const from = new Date(`${fromKey}T12:00:00Z`);
  const to = new Date(`${toKey}T12:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function upcomingBills(profile = {}, now = new Date(), horizonDays = 3) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  const local = localParts(now, preferences.timezone);
  return (Array.isArray(profile.transactions) ? profile.transactions : [])
    .filter(item => {
      const type = String(item?.type || item?.tipo || '').toLowerCase();
      const status = String(item?.status || 'paid').toLowerCase();
      const due = transactionIsoDate(item);
      if (!due || !['expense', 'despesa', 'saida', 'saída'].includes(type)) return false;
      if (!(item?.pending === true || status.includes('pend'))) return false;
      const days = daysBetweenDateKeys(local.dateKey, due);
      return days >= 0 && days <= horizonDays;
    })
    .map(item => ({
      id: String(item.id || crypto.createHash('sha1').update(JSON.stringify(item)).digest('hex').slice(0, 12)),
      description: String(item.description || item.desc || item.name || 'Conta'),
      amount: Math.abs(asNumber(item.amount ?? item.value ?? item.valor)),
      dueDate: transactionIsoDate(item),
      days: daysBetweenDateKeys(local.dateKey, transactionIsoDate(item)),
    }));
}

function nextCardDueDate(dateKey, dueDay) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const rawDay = Math.trunc(asNumber(dueDay));
  if (rawDay < 1) return '';
  const parsedDay = Math.min(31, rawDay);
  let due = new Date(Date.UTC(year, month - 1, parsedDay, 12));
  if (due.getUTCMonth() !== month - 1) due = new Date(Date.UTC(year, month, 0, 12));
  if (Number(dateKey.replace(/-/g, '')) > Number(due.toISOString().slice(0, 10).replace(/-/g, ''))) {
    due = new Date(Date.UTC(year, month, parsedDay, 12));
    if (due.getUTCMonth() !== month) due = new Date(Date.UTC(year, month + 1, 0, 12));
  }
  return due.toISOString().slice(0, 10);
}

function upcomingCardInvoices(profile = {}, now = new Date(), horizonDays = 7) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  const local = localParts(now, preferences.timezone);
  const accounts = buildAccountsAndCards(profile, now);
  return accounts.cards
    .filter(card => card.totalOpen > 0 && card.dueDay)
    .map(card => {
      const dueDate = nextCardDueDate(local.dateKey, card.dueDay);
      return { ...card, dueDate, days: dueDate ? daysBetweenDateKeys(local.dateKey, dueDate) : 999 };
    })
    .filter(card => card.days >= 0 && card.days <= horizonDays);
}

function hasTransactionToday(profile = {}, now = new Date()) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  const today = localParts(now, preferences.timezone).dateKey;
  return (Array.isArray(profile.transactions) ? profile.transactions : []).some(item => transactionIsoDate(item) === today);
}

async function dispatchAlreadyExists(userId, key) {
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
  const ref = database().collection('users').doc(userId).collection('notification_dispatches').doc(id);
  const snap = await ref.get();
  return { exists: snap.exists, ref };
}

async function markDispatched(ref, key, now = new Date()) {
  await ref.set({ key, sentAt: now.toISOString() }, { merge: true });
}

async function clearInvalidSubscription(userId, profile = {}) {
  await database().collection('users').doc(userId).set({
    pushSubscription: null,
    pushEnabled: false,
    notificationPreferences: {
      ...normalizeNotificationPreferences(profile.notificationPreferences),
      enabled: false,
    },
  }, { merge: true });
}

async function sendPushToProfile(userId, profile, notification) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  if (!preferences.enabled || profile.pushEnabled === false) return false;

  let nativeError = null;
  if (nativeDeviceEntries(profile).length) {
    try {
      const nativeSent = await sendNativeToProfile(userId, profile, notification);
      if (nativeSent) return true;
    } catch (error) {
      nativeError = error;
      console.warn(`FCM nativo falhou (${userId}):`, error.message);
    }
  }

  if (!profile.pushSubscription) {
    if (nativeError) throw nativeError;
    return false;
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    if (nativeError) throw nativeError;
    throw new Error('VAPID não configurado no servidor.');
  }

  let subscription;
  try {
    subscription = typeof profile.pushSubscription === 'string'
      ? JSON.parse(profile.pushSubscription)
      : profile.pushSubscription;
  } catch (_) {
    await clearInvalidSubscription(userId, profile);
    return false;
  }

  try {
    await pushClient().sendNotification(subscription, JSON.stringify({
      title: notification.title,
      body: notification.body,
      icon: '/favicon.png',
      badge: '/favicon.png',
      tag: notification.tag || 'allofinancas',
      data: { url: notification.url || '/app' },
      requireInteraction: false,
    }));
    return true;
  } catch (error) {
    if ([404, 410].includes(error.statusCode)) await clearInvalidSubscription(userId, profile);
    throw error;
  }
}

async function sendOnce(userId, profile, key, notification, now = new Date()) {
  const dispatch = await dispatchAlreadyExists(userId, key);
  if (dispatch.exists) return false;
  const sent = await sendPushToProfile(userId, profile, notification);
  if (sent) await markDispatched(dispatch.ref, key, now);
  return sent;
}

async function processUserNotifications(userId, profile, now = new Date()) {
  const preferences = normalizeNotificationPreferences(profile.notificationPreferences);
  if (!preferences.enabled || profile.pushEnabled === false || !hasNotificationTarget(profile)) return 0;

  const local = localParts(now, preferences.timezone);
  const timeReached = notificationTimeReached(preferences, now);
  let sent = 0;

  if (timeReached && preferences.dailySummary) {
    if (await sendOnce(userId, profile, `daily:${local.dateKey}`, buildDailySummary(profile, now), now)) sent += 1;
  }

  if (timeReached && preferences.billAlerts) {
    for (const bill of upcomingBills(profile, now)) {
      const when = bill.days === 0 ? 'vence hoje' : `vence em ${bill.days} dia${bill.days === 1 ? '' : 's'}`;
      if (await sendOnce(userId, profile, `bill:${bill.id}:${bill.dueDate}`, {
        title: '⏰ Uma conta pede sua atenção',
        body: `${bill.description}: ${money(bill.amount)} ${when}. Abra o Allofy para conferir.`,
        tag: `bill-${bill.id}`,
        url: '/app?action=open-calendar&via=notification',
      }, now)) sent += 1;
    }
  }

  if (timeReached && preferences.cardAlerts) {
    for (const card of upcomingCardInvoices(profile, now)) {
      const when = card.days === 0 ? 'vence hoje' : `vence em ${card.days} dia${card.days === 1 ? '' : 's'}`;
      const cardKey = crypto.createHash('sha1').update(`${card.name}|${card.dueDate}`).digest('hex').slice(0, 12);
      if (await sendOnce(userId, profile, `card:${cardKey}:${card.dueDate}`, {
        title: `💳 Sua fatura ${card.name} está chegando`,
        body: `${money(card.totalOpen)} em aberto e ${when}. Veja os detalhes no Allofy.`,
        tag: `card-${cardKey}`,
        url: '/app?action=open-cards&via=notification',
      }, now)) sent += 1;
    }
  }

  if (timeReached && preferences.weeklySummary && local.weekday === 1) {
    if (await sendOnce(userId, profile, `weekly:${local.dateKey}`, buildWeeklySummary(profile, now), now)) sent += 1;
  }

  if (preferences.inactivityReminder && local.hour * 60 + local.minute >= 20 * 60 && !hasTransactionToday(profile, now)) {
    if (await sendOnce(userId, profile, `inactive:${local.dateKey}`, {
      title: '📝 Fechou o dia? O Allofy te ajuda',
      body: 'Registre o que entrou ou saiu hoje em poucos segundos e mantenha seu mês sempre em dia.',
      tag: 'inactivity-reminder',
      url: '/app?action=add-expense&via=notification',
    }, now)) sent += 1;
  }

  return sent;
}

async function runNotificationCycle(now = new Date()) {
  const snapshot = await database().collection('users').where('pushEnabled', '==', true).get();
  let sent = 0;
  let failures = 0;

  for (const doc of snapshot.docs) {
    try {
      const profile = await hydrateProfile(doc.id, doc.data() || {}, [
        'transactions', 'banks', 'cards', 'cardTransactions', 'debts', 'benefits'
      ]);
      sent += await processUserNotifications(doc.id, profile, now);
    } catch (error) {
      failures += 1;
      console.warn(`Notification cycle error (${doc.id}):`, error.message);
    }
  }

  return { users: snapshot.size, sent, failures, executedAt: now.toISOString() };
}

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  localParts,
  notificationTimeReached,
  currentMonthTotals,
  buildDailySummary,
  buildWeeklySummary,
  upcomingBills,
  upcomingCardInvoices,
  processUserNotifications,
  runNotificationCycle,
  sendPushToProfile,
  sendNativeToProfile,
  nativeDeviceEntries,
  hasNotificationTarget,
};
