const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyMercadoPagoSignature } = require('../src/utils/mercadoPagoWebhook');
const { dateKey, clampDateKey, extendExpiry } = require('../src/utils/saoPaulo');

test('valida assinatura Mercado Pago usando manifest oficial', () => {
  const secret = 'segredo-de-teste';
  const ts = String(Date.now());
  const requestId = 'req-123';
  const dataId = 'ABC123';
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  assert.equal(verifyMercadoPagoSignature({ signature: `ts=${ts},v1=${v1}`, requestId, dataId, secret }), true);
  assert.equal(verifyMercadoPagoSignature({ signature: `ts=${ts},v1=${'0'.repeat(64)}`, requestId, dataId, secret }), false);
});

test('gera data de São Paulo sem avançar para o dia seguinte por UTC', () => {
  assert.equal(dateKey(new Date('2026-08-06T00:30:00.000Z')), '2026-08-05');
});

test('limita recorrência ao último dia válido do mês', () => {
  assert.equal(clampDateKey(2026, 2, 31), '2026-02-28');
  assert.equal(clampDateKey(2028, 2, 31), '2028-02-29');
});

test('prêmio estende uma assinatura já ativa', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(extendExpiry('2026-09-01T12:00:00.000Z', 30, now), '2026-10-01T12:00:00.000Z');
});

const { getTodayRange, getMonthRange } = require('../src/utils/dateUtils');
const { safeDocId, stableHash } = require('../src/services/v39ProfileService');

test('intervalos financeiros respeitam a data civil de São Paulo à noite', () => {
  const now = new Date('2026-08-06T00:30:00.000Z');
  const today = getTodayRange(now);
  assert.equal(today.start.toISOString(), '2026-08-05T03:00:00.000Z');
  assert.equal(today.end.toISOString(), '2026-08-06T02:59:59.999Z');
  const month = getMonthRange(now);
  assert.equal(month.start.toISOString(), '2026-08-01T03:00:00.000Z');
  assert.equal(month.end.toISOString(), '2026-09-01T02:59:59.999Z');
});

test('migração V39 gera identificadores determinísticos e seguros', () => {
  const item = { description: 'Mercado', amount: 42.5 };
  assert.equal(stableHash(item), stableHash({ description: 'Mercado', amount: 42.5 }));
  const first = safeDocId(item, 0, new Set());
  const second = safeDocId(item, 0, new Set());
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});
