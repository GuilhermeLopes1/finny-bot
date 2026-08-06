'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dateKey, clampDateKey, extendExpiry } = require('../src/utils/saoPaulo');
const {
  maxExpiry,
  captureLegacyExpiry,
  buildEffectiveProUpdate,
} = require('../src/services/proEntitlementService');
const { getTodayRange, getMonthRange } = require('../src/utils/dateUtils');
const { safeDocId, stableHash } = require('../src/services/v39ProfileService');

test('gera data de São Paulo sem avançar para o dia seguinte por UTC', () => {
  assert.equal(dateKey(new Date('2026-08-06T00:30:00.000Z')), '2026-08-05');
});

test('limita recorrência ao último dia válido do mês', () => {
  assert.equal(clampDateKey(2026, 2, 31), '2026-02-28');
  assert.equal(clampDateKey(2028, 2, 31), '2028-02-29');
});

test('prêmio estende uma validade já existente', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(extendExpiry('2026-09-01T12:00:00.000Z', 30, now), '2026-10-01T12:00:00.000Z');
});

test('direito Pro usa a maior validade entre Google Play, prêmio e liberação manual', () => {
  assert.equal(maxExpiry([
    '2026-09-01T12:00:00.000Z',
    '2026-10-15T12:00:00.000Z',
    '2026-09-30T12:00:00.000Z',
  ]), '2026-10-15T12:00:00.000Z');
});

test('sincronização Google Play preserva validade Pro legada maior', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const profile = { isPro: true, proExpiresAt: '2026-12-01T12:00:00.000Z' };
  const patch = { googlePlayExpiresAt: '2026-09-01T12:00:00.000Z' };
  assert.equal(captureLegacyExpiry(profile, patch, now), '2026-12-01T12:00:00.000Z');
  const update = buildEffectiveProUpdate(profile, patch, now);
  assert.equal(update.isPro, true);
  assert.equal(update.proExpiresAt, '2026-12-01T12:00:00.000Z');
});

test('direito é removido quando todas as fontes expiraram', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const update = buildEffectiveProUpdate({
    googlePlayExpiresAt: '2026-08-04T12:00:00.000Z',
    proPrizeExpiresAt: '2026-08-03T12:00:00.000Z',
  }, {}, now);
  assert.equal(update.isPro, false);
  assert.equal(update.proDaysLeft, 0);
});

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
