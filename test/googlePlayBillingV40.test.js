'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('backend usa subscriptionsv2 e confirma assinatura no servidor', () => {
  const service = read('src/services/googlePlayBillingService.js');
  assert.match(service, /purchases\/subscriptionsv2\/tokens/);
  assert.match(service, /:acknowledge/);
  assert.match(service, /linkedPurchaseToken/);
  assert.match(service, /outOfAppPurchaseContext/);
  assert.match(service, /expiredPurchaseToken/);
  assert.match(service, /google_play_purchases/);
  assert.doesNotMatch(service, /Mercado Pago|MP_ACCESS_TOKEN/);
});

test('rotas Google Play exigem autenticação na verificação e protegem reconciliação', () => {
  const controller = read('src/controllers/googlePlayBillingController.js');
  assert.match(controller, /\/google-play\/verify-subscription', requireSignedInUser/);
  assert.match(controller, /\/google-play\/reconcile/);
  assert.match(controller, /CRON_SECRET/);
  assert.match(controller, /verifyRtdnOidcToken/);
});

test('servidor não oferece rotas externas de pagamento', () => {
  const server = read('src/server.js');
  for (const route of ['/create-payment','/create-payment-pix','/cancel-subscription','/webhook-mp']) {
    assert.doesNotMatch(server, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(server, /registerGooglePlayBillingRoutes/);
  assert.match(server, /reconcileGooglePlaySubscriptions/);
});

test('variáveis de ambiente não incluem segredos do Mercado Pago', () => {
  const env = read('.env.example');
  assert.match(env, /GOOGLE_PLAY_CREDENTIALS=/);
  assert.match(env, /GOOGLE_PLAY_PACKAGE_NAME=com\.allofinancas/);
  assert.match(env, /GOOGLE_PLAY_PRODUCT_MONTHLY=allofy_pro_monthly/);
  assert.match(env, /GOOGLE_PLAY_PRODUCT_YEARLY=allofy_pro_yearly/);
  assert.match(env, /GOOGLE_PLAY_RTDN_AUDIENCE=/);
  assert.doesNotMatch(env, /MP_ACCESS_TOKEN|MP_WEBHOOK_SECRET/);
});

test('concessões administrativas usam fontes separadas e recalculam o direito Pro no backend', () => {
  const server = read('src/server.js');
  assert.match(server, /grant-manual-pro/);
  assert.match(server, /extend-manual-pro/);
  assert.match(server, /revoke-manual-pro/);
  assert.match(server, /buildEffectiveProUpdate/);
  assert.match(server, /proManualExpiresAt/);
});


test('credenciais da Google Play não usam a conta do Firebase como fallback', () => {
  const service = read('src/services/googlePlayBillingService.js');
  assert.match(service, /GOOGLE_PLAY_CREDENTIALS/);
  assert.doesNotMatch(service, /GOOGLE_PLAY_CREDENTIALS\s*\|\|\s*process\.env\.GOOGLE_CREDENTIALS/);
  assert.match(service, /BEGIN PRIVATE KEY/);
});

test('erros de permissão recebem código estável e resposta temporária', () => {
  const controller = read('src/controllers/googlePlayBillingController.js');
  assert.match(controller, /google_play_permission_pending/);
  assert.match(controller, /retryable:\s*true/);
  assert.match(controller, /tokenHash\(purchaseToken\)\.slice/);
  assert.doesNotMatch(controller, /purchaseToken=\$\{/);
});
