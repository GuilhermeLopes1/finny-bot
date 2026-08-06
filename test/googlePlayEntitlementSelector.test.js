'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activePurchaseRecord,
  latestPurchaseRecord,
} = require('../src/services/googlePlayEntitlementSelector');

const now = new Date('2026-08-05T12:00:00.000Z');

test('token antigo não encurta uma assinatura mais nova', () => {
  const selected = activePurchaseRecord([
    { productId: 'allofy_pro_monthly', entitled: true, expiryTime: '2026-09-05T12:00:00.000Z' },
    { productId: 'allofy_pro_yearly', entitled: true, expiryTime: '2027-08-05T12:00:00.000Z' },
  ], now);
  assert.equal(selected.productId, 'allofy_pro_yearly');
});

test('compra expirada ou sem direito não é escolhida', () => {
  const selected = activePurchaseRecord([
    { productId: 'expired', entitled: true, expiryTime: '2026-08-04T12:00:00.000Z' },
    { productId: 'revoked', entitled: false, expiryTime: '2027-08-05T12:00:00.000Z' },
  ], now);
  assert.equal(selected, null);
});

test('registro mais recente é usado para exibir o último estado da loja', () => {
  const selected = latestPurchaseRecord([
    { state: 'ACTIVE', updatedAt: '2026-08-01T12:00:00.000Z' },
    { state: 'CANCELED', updatedAt: '2026-08-05T12:00:00.000Z' },
  ]);
  assert.equal(selected.state, 'CANCELED');
});
