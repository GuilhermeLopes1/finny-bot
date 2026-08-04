const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeTransactions,
  periodRange,
  cleanTransaction,
  asNumber,
  collectTransactions,
  financialOverview,
  executeAllofyTool,
  getAccountActivity,
} = require('../src/services/allofyTools');

test('converte valores brasileiros sem perder centavos', () => {
  assert.equal(asNumber('R$ 1.234,56'), 1234.56);
  assert.equal(asNumber(27.4), 27.4);
  assert.equal(asNumber('inválido'), 0);
});

test('calcula o mês atual e separa pendências do realizado', () => {
  const now = new Date(2026, 7, 15);
  const summary = summarizeTransactions([
    { type: 'income', amount: 3000, date: '2026-08-01', category: 'Salário' },
    { type: 'expense', amount: 250.5, date: '2026-08-10', category: 'Mercado' },
    { type: 'expense', amount: 100, date: '2026-07-20', category: 'Lazer' },
    { type: 'expense', amount: 80, date: '2026-08-12', category: 'Mercado', status: 'pending' },
  ], 'month', now);
  assert.equal(summary.income, 3000);
  assert.equal(summary.expenses, 250.5);
  assert.equal(summary.balance, 2749.5);
  assert.equal(summary.byCategory.Mercado, 250.5);
  assert.equal(summary.pending, 80);
  assert.equal(summary.pendingExpenses, 80);
  assert.equal(summary.count, 3);
});

test('normaliza uma transação sem expor campos extras', () => {
  assert.deepEqual(cleanTransaction({ desc: 'Padaria', valor: '18,90', tipo: 'despesa', data: '2026-08-03', categoria: 'Alimentação', secret: 'não vaza' }), {
    description: 'Padaria', amount: 18.9, type: 'expense', category: 'Alimentação', date: '2026-08-03', status: 'paid', account: '',
  });
});

test('intervalo do mês anterior termina no primeiro dia do mês atual', () => {
  const range = periodRange('last_month', new Date(2026, 7, 15));
  assert.deepEqual([range.start.getFullYear(), range.start.getMonth(), range.start.getDate()], [2026, 6, 1]);
  assert.deepEqual([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()], [2026, 7, 1]);
});

test('resolve bankId, category e cardId para nomes reais', () => {
  const profile = {
    banks: [{ id: 'b1', name: 'Nubank', accountName: 'Conta principal', type: 'corrente', balance: 900 }],
    categories: [{ id: 'c1', name: 'Alimentação', emoji: '🍔' }],
    cards: [{ id: 'card1', name: 'Nubank Platinum', brand: 'Mastercard', last4: '1234', limit: 3000 }],
    transactions: [{ id: 't1', description: 'Mercado', amount: 15, type: 'expense', date: '2026-08-03', category: 'c1', bankId: 'b1', status: 'paid' }],
    cardTransactions: [{ id: 'cp1', descricao: 'Farmácia', valorTotal: 50, parcelas: 2, dataCompra: '2026-08-02', categoria: 'Saúde', cardId: 'card1' }],
  };
  const { items } = collectTransactions(profile);
  const tx = items.find(item => item.id === 't1');
  const cardPurchase = items.find(item => item.id === 'cp1');
  assert.equal(tx.account.name, 'Conta principal');
  assert.equal(tx.account.institution, 'Nubank');
  assert.equal(tx.category.name, 'Alimentação');
  assert.equal(cardPurchase.card.name, 'Nubank Platinum');
  assert.equal(cardPurchase.installments, 2);
  assert.equal(cardPurchase.installmentValue, 25);
});

test('pesquisa transações por conta e data exata', async () => {
  const profile = {
    banks: [
      { id: 'b1', name: 'Nubank', accountName: 'Conta principal', balance: 100 },
      { id: 'b2', name: 'Inter', accountName: 'Reserva', balance: 500 },
    ],
    categories: [{ id: 'c1', name: 'Alimentação' }],
    transactions: [
      { id: 't1', description: 'Padaria', amount: 15, type: 'expense', date: '2026-08-03', category: 'c1', bankId: 'b1', status: 'paid' },
      { id: 't2', description: 'Mercado', amount: 80, type: 'expense', date: '2026-08-03', category: 'c1', bankId: 'b2', status: 'paid' },
    ],
  };
  const result = await executeAllofyTool('search_transactions', {
    period: 'all', startDate: null, endDate: null, exactDate: '2026-08-03',
    type: 'all', status: 'all', category: null, account: 'conta principal',
    card: null, benefit: null, query: null, recurrence: 'all', source: 'all',
    includeTransfers: true, minAmount: null, maxAmount: null, sort: 'date_desc', limit: 50,
  }, 'uid', profile);
  assert.equal(result.matched, 1);
  assert.equal(result.items[0].id, 't1');
  assert.equal(result.items[0].account.institution, 'Nubank');
});

test('resumo evita dupla contagem de transferência, benefício e pagamento de fatura', () => {
  const profile = {
    banks: [{ id: 'b1', name: 'Nubank', balance: 1000 }],
    cards: [{ id: 'card1', name: 'Cartão', limit: 2000 }],
    categories: [{ id: 'c1', name: 'Alimentação' }],
    benefits: [{ id: 'ben1', name: 'VA', total: 500, transactions: [] }],
    transactions: [
      { id: 'income', description: 'Salário', amount: 1000, type: 'income', date: '2026-08-01', bankId: 'b1', status: 'paid' },
      { id: 'cash', description: 'Padaria', amount: 15, type: 'expense', date: '2026-08-02', bankId: 'b1', category: 'c1', status: 'paid' },
      { id: 'transfer', description: 'Transferência', amount: 100, type: 'expense', date: '2026-08-02', bankId: 'b1', status: 'paid', isTransfer: true },
      { id: 'benefit', description: 'Almoço VA', amount: 30, type: 'expense', date: '2026-08-02', benefitId: 'ben1', coveredByBenefit: true, status: 'paid' },
      { id: 'invoice', description: 'Pagamento Fatura – Cartão', amount: 200, type: 'expense', date: '2026-08-03', bankId: 'b1', status: 'paid' },
    ],
    cardTransactions: [{ id: 'purchase', descricao: 'Mercado crédito', valorTotal: 200, parcelas: 1, dataCompra: '2026-08-02', categoria: 'Alimentação', cardId: 'card1' }],
  };
  const overview = financialOverview(profile, { period: 'custom', startDate: '2026-08-01', endDate: '2026-08-31', exactDate: null }, new Date(2026, 7, 15));
  assert.equal(overview.income, 1000);
  assert.equal(overview.expenses, 215);
  assert.equal(overview.balance, 785);
  assert.equal(overview.counts.transfers, 1);
  assert.equal(overview.counts.cardPurchases, 1);
});

test('atividade da conta inclui transações e conciliações', () => {
  const profile = {
    banks: [{
      id: 'b1', name: 'Nubank', accountName: 'Conta principal', balance: 500,
      balanceHistory: [{ id: 'adj1', oldBalance: 480, newBalance: 500, delta: 20, note: 'Conciliação', date: '2026-08-03' }],
    }],
    transactions: [{ id: 't1', description: 'Padaria', amount: 15, type: 'expense', date: '2026-08-03', bankId: 'b1', status: 'paid' }],
  };
  const result = getAccountActivity(profile, { account: 'Nubank', period: 'all', startDate: null, endDate: null, exactDate: null, limit: 20 });
  assert.equal(result.matchedAccounts.length, 1);
  assert.equal(result.activities.length, 2);
  assert.ok(result.activities.some(item => item.kind === 'balance_adjustment'));
});

test('resumo mensal agrupa despesas pendentes por conta e lista os itens', () => {
  const profile = {
    banks: [
      { id: 'luh', name: 'Nubank', accountName: 'Nubank Luh', balance: 0 },
      { id: 'gui', name: 'Nubank', accountName: 'Nubank Gui', balance: 0 },
    ],
    categories: [
      { id: 'cartao', name: 'Cartão' },
      { id: 'pessoal', name: 'Pessoal' },
    ],
    transactions: [
      { id: 'paid', description: 'Compra', amount: 15, type: 'expense', date: '2026-08-03', category: 'cartao', bankId: 'luh', status: 'paid' },
      { id: 'pending1', description: 'Psicóloga', amount: 100, type: 'expense', date: '2026-08-20', category: 'pessoal', bankId: 'luh', status: 'pending' },
      { id: 'pending2', description: 'Palio', amount: 200, type: 'expense', date: '2026-08-20', category: 'pessoal', bankId: 'luh', status: 'pending' },
      { id: 'pending3', description: 'Vivo', amount: 75.34, type: 'expense', date: '2026-08-20', category: 'pessoal', bankId: 'gui', status: 'pending' },
    ],
  };
  const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null }, new Date(2026, 7, 4));
  assert.equal(overview.expenses, 15);
  assert.equal(overview.pendingExpenses, 375.34);
  assert.equal(overview.counts.pendingExpenses, 3);
  assert.equal(overview.pendingItems.length, 3);
  assert.equal(overview.pendingItems[0].account.name, 'Nubank Luh');
  const luh = overview.pendingByAccount.find(item => item.name === 'Nubank Luh');
  const gui = overview.pendingByAccount.find(item => item.name === 'Nubank Gui');
  assert.equal(luh.pendingExpenses, 300);
  assert.equal(gui.pendingExpenses, 75.34);
  assert.match(overview.suggestedResponse, /Despesas pendentes/);
  assert.match(overview.suggestedResponse, /Psicóloga/);
  assert.match(overview.suggestedResponse, /Nubank Luh/);
});

test('compra de cartão pendente não entra nas despesas realizadas', () => {
  const profile = {
    cards: [{ id: 'c1', name: 'Cartão Gui', brand: 'Mastercard' }],
    cardTransactions: [
      { id: 'cp1', descricao: 'Compra futura', valorTotal: 90, dataCompra: '2026-08-10', cardId: 'c1', status: 'pending' },
    ],
  };
  const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null }, new Date(2026, 7, 4));
  assert.equal(overview.expenses, 0);
  assert.equal(overview.pendingExpenses, 90);
  assert.equal(overview.pendingItems[0].card.name, 'Cartão Gui');
});

test('resumo completo inclui faturas abertas e parcelas de dívidas do mês', () => {
  const profile = {
    banks: [
      { id: 'luh', name: 'Nubank', accountName: 'Nubank Luh', balance: 34.5 },
      { id: 'gui', name: 'Nubank', accountName: 'Nubank Gui', balance: 0.77 },
    ],
    cards: [
      {
        id: 'card-luh', name: 'Bradesco Luh', brand: 'Visa', limit: 2000, due: 12,
        invoiceOverrides: { '2026-08': { amount: 807.22 } }, invoicePayments: {}, debtBalance: 0,
      },
      {
        id: 'card-gui', name: 'Caixa Gui', brand: 'Mastercard', limit: 6000, due: 21,
        invoiceOverrides: { '2026-08': { amount: 4457.73 } }, invoicePayments: {}, debtBalance: 50,
      },
    ],
    debts: [
      {
        id: 'debt1', name: 'Financiamento Palio', total: 12000, paid: 4000, installment: 500,
        dueDay: 20, status: 'pending', payments: [{ id: 'p1', amount: 500, date: '2026-07-20', bankId: 'luh' }],
      },
    ],
    transactions: [
      { id: 'tx1', description: 'Luiza', amount: 15, type: 'expense', date: '2026-08-10', bankId: 'luh', status: 'paid' },
    ],
  };

  const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null }, new Date(2026, 7, 4));
  assert.equal(overview.commitments.totals.cardInvoicesOpen, 5314.95);
  assert.equal(overview.commitments.totals.debtInstallmentsOpen, 500);
  assert.equal(overview.commitments.totals.activeDebtBalance, 8000);
  assert.equal(overview.commitments.openCardInvoices.length, 2);
  assert.equal(overview.commitments.openDebts.length, 1);
  const luh = overview.commitments.byAccount.find(item => item.name === 'Nubank Luh');
  const gui = overview.commitments.byAccount.find(item => item.name === 'Nubank Gui');
  assert.equal(luh.cardInvoicesOpen, 807.22);
  assert.equal(luh.debtInstallmentsOpen, 500);
  assert.equal(gui.cardInvoicesOpen, 4507.73);
  assert.match(overview.suggestedCompleteResponse, /FATURAS DE CARTÃO EM ABERTO/);
  assert.match(overview.suggestedCompleteResponse, /DÍVIDAS E FINANCIAMENTOS/);
  assert.match(overview.suggestedCompleteResponse, /Bradesco Luh/);
  assert.match(overview.suggestedCompleteByAccountResponse, /NUBANK LUH/);
  assert.match(overview.suggestedCompleteByAccountResponse, /NUBANK GUI/);
  assert.match(overview.suggestedCompleteByAccountResponse, /Faturas abertas:/);
  assert.match(overview.suggestedCompleteByAccountResponse, /Dívidas e financiamentos:/);
  assert.doesNotMatch(overview.suggestedCompleteResponse, /\*\*|^#/m);
});

test('dívida paga no mês não deixa parcela aberta novamente', () => {
  const profile = {
    banks: [{ id: 'gui', name: 'Nubank', accountName: 'Nubank Gui' }],
    debts: [{
      id: 'd1', name: 'Empréstimo Gui', total: 3000, paid: 1000, installment: 200,
      dueDay: 10, status: 'pending', payments: [{ amount: 200, date: '2026-08-02', bankId: 'gui' }],
    }],
  };
  const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null }, new Date(2026, 7, 4));
  assert.equal(overview.commitments.openDebts[0].installmentOpen, 0);
  assert.equal(overview.commitments.totals.debtInstallmentsOpen, 0);
});
