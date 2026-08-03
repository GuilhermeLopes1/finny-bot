const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeNotificationPreferences,
  notificationTimeReached,
  buildDailySummary,
  upcomingBills,
  upcomingCardInvoices,
} = require('../src/services/notificationService');

test('mantém notificações desligadas até o usuário ativar explicitamente', () => {
  const prefs = normalizeNotificationPreferences({ dailyTime: '99:99' });
  assert.equal(prefs.enabled, false);
  assert.equal(prefs.dailyTime, '08:00');
  assert.equal(prefs.dailySummary, true);
});

test('respeita o horário escolhido no fuso de São Paulo', () => {
  const prefs = normalizeNotificationPreferences({
    enabled: true,
    dailyTime: '08:30',
    timezone: 'America/Sao_Paulo',
  });
  assert.equal(notificationTimeReached(prefs, new Date('2026-08-03T11:20:00Z')), false);
  assert.equal(notificationTimeReached(prefs, new Date('2026-08-03T11:35:00Z')), true);
});

test('resumo diário usa fatura informada manualmente', () => {
  const profile = {
    name: 'Guilherme Lopes',
    notificationPreferences: { timezone: 'America/Sao_Paulo' },
    transactions: [
      { type: 'income', amount: 3000, date: '2026-08-01', status: 'paid' },
      { type: 'expense', amount: 250, date: '2026-08-02', status: 'paid' },
    ],
    banks: [{ name: 'Caixa', balance: 1200 }],
    cards: [{
      id: 'card-1',
      name: 'Caixa Gui',
      limit: 5000,
      due: 5,
      invoiceOverrides: { '2026-08': { amount: 2570.57 } },
      invoicePayments: {},
    }],
  };
  const summary = buildDailySummary(profile, new Date('2026-08-03T12:00:00Z'));
  assert.equal(summary.details.totalInvoicesOpen, 2570.57);
  assert.equal(summary.details.balance, 2750);
  assert.match(summary.body, /2\.570,57/);
});

test('identifica contas e faturas próximas do vencimento', () => {
  const profile = {
    notificationPreferences: { timezone: 'America/Sao_Paulo' },
    transactions: [
      { id: 'bill-1', type: 'expense', amount: 180, date: '2026-08-05', status: 'pending', description: 'Internet' },
    ],
    cards: [{
      id: 'card-1', name: 'Caixa Gui', due: 5, limit: 5000,
      invoiceOverrides: { '2026-08': 2570.57 }, invoicePayments: {},
    }],
  };
  const now = new Date('2026-08-03T12:00:00Z');
  const bills = upcomingBills(profile, now, 3);
  const cards = upcomingCardInvoices(profile, now, 7);
  assert.equal(bills.length, 1);
  assert.equal(bills[0].days, 2);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].days, 2);
  assert.equal(cards[0].totalOpen, 2570.57);
});
