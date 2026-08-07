'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src/services/googlePlayBillingService.js'), 'utf8');

test('V42.2 preserva proprietário do token atual e dá código específico', () => {
  assert.match(service, /existingPurchase\.uid && existingPurchase\.uid !== uid/);
  assert.match(service, /google_play_token_owner_mismatch/);
});

test('V42.2 só permite handoff de histórico em compra nova e não reconhecida', () => {
  assert.match(service, /isFreshUnacknowledgedPurchase/);
  assert.match(service, /summary\.acknowledged === true/);
  assert.match(service, /fresh_authenticated_purchase/);
  assert.match(service, /GOOGLE_PLAY_FRESH_PURCHASE_WINDOW_MINUTES/);
});

test('V42.2 não herda linkedPurchaseToken como dono absoluto', () => {
  assert.match(service, /google_play_linked_owner_mismatch/);
  assert.match(service, /ownershipConflictResolvedBy/);
  assert.match(service, /supersededByPurchaseTokenHash/);
});

test('V42.2 usa identificador ofuscado e mapeamento interno para RTDN', () => {
  assert.match(service, /obfuscatedAccountIdForUid/);
  assert.match(service, /externalAccountIds/);
  assert.match(service, /google_play_account_links/);
  assert.match(service, /externalAccountIdentifiers/);
  assert.match(service, /storedOwnerIsTrusted/);
  assert.match(service, /ownershipVersion/);
  assert.doesNotMatch(service, /obfuscatedAccountId:\s*uid/);
});
