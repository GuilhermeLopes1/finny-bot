const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTransactions, periodRange, cleanTransaction, asNumber } = require('../src/services/allofyTools');

test('converte valores brasileiros sem perder centavos', () => {
  assert.equal(asNumber('R$ 1.234,56'), 1234.56);
  assert.equal(asNumber(27.4), 27.4);
  assert.equal(asNumber('inválido'), 0);
});

test('calcula o mês atual sem misturar transações de outros períodos', () => {
  const now = new Date(2026, 7, 15);
  const summary = summarizeTransactions([
    { type: 'income', amount: 3000, date: '2026-08-01', category: 'Salário' },
    { type: 'expense', amount: 250.5, date: '2026-08-10', category: 'Mercado' },
    { type: 'expense', amount: 100, date: '2026-07-20', category: 'Lazer' },
    { type: 'expense', amount: 80, date: '2026-08-12', category: 'Mercado', status: 'pending' },
  ], 'month', now);
  assert.equal(summary.income, 3000);
  assert.equal(summary.expenses, 330.5);
  assert.equal(summary.balance, 2669.5);
  assert.equal(summary.byCategory.Mercado, 330.5);
  assert.equal(summary.pending, 80);
  assert.equal(summary.count, 3);
});

test('normaliza uma transação sem expor campos extras', () => {
  assert.deepEqual(cleanTransaction({ desc: 'Padaria', valor: '18,90', tipo: 'despesa', data: '2026-08-03', categoria: 'Alimentação', secret: 'não vaza' }), {
    description: 'Padaria', amount: 18.9, type: 'expense', category: 'Alimentação', date: '2026-08-03', status: 'confirmed', account: '',
  });
});

test('intervalo do mês anterior termina no primeiro dia do mês atual', () => {
  const range = periodRange('last_month', new Date(2026, 7, 15));
  assert.deepEqual([range.start.getFullYear(), range.start.getMonth(), range.start.getDate()], [2026, 6, 1]);
  assert.deepEqual([range.end.getFullYear(), range.end.getMonth(), range.end.getDate()], [2026, 7, 1]);
});
