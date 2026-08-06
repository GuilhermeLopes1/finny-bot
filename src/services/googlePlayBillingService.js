'use strict';

const crypto = require('crypto');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const logger = require('../utils/logger');
const { buildEffectiveProUpdate, toMillis } = require('./proEntitlementService');
const { activePurchaseRecord, latestPurchaseRecord } = require('./googlePlayEntitlementSelector');

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_PACKAGE_NAME = 'com.allofinancas';
const DEFAULT_PRODUCTS = Object.freeze({
  monthly: 'allofy_pro_monthly',
  yearly: 'allofy_pro_yearly',
});

let publisherAuth;
let rtdnVerifier;

function packageName() {
  return String(process.env.GOOGLE_PLAY_PACKAGE_NAME || DEFAULT_PACKAGE_NAME).trim();
}

function productConfig() {
  return Object.freeze({
    monthly: String(process.env.GOOGLE_PLAY_PRODUCT_MONTHLY || DEFAULT_PRODUCTS.monthly).trim(),
    yearly: String(process.env.GOOGLE_PLAY_PRODUCT_YEARLY || DEFAULT_PRODUCTS.yearly).trim(),
  });
}

function productToPlan(productId) {
  const products = productConfig();
  if (productId === products.monthly) return 'pro-monthly';
  if (productId === products.yearly) return 'pro-yearly';
  return null;
}

function allowedProductIds() {
  return new Set(Object.values(productConfig()));
}

function parseCredentials() {
  const raw = process.env.GOOGLE_PLAY_CREDENTIALS || process.env.GOOGLE_CREDENTIALS;
  if (!raw) {
    throw Object.assign(new Error('Credenciais da Google Play não configuradas.'), { status: 503 });
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`Credenciais da Google Play inválidas: ${error.message}`), { status: 503 });
  }

  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return credentials;
}

function getPublisherAuth() {
  if (!publisherAuth) {
    publisherAuth = new GoogleAuth({
      credentials: parseCredentials(),
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
  }
  return publisherAuth;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function ensureValidToken(value) {
  const token = String(value || '').trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw Object.assign(new Error('Token de compra inválido.'), { status: 400 });
  }
  return token;
}

async function publisherRequest({ method = 'GET', url, data }) {
  try {
    const client = await getPublisherAuth().getClient();
    const response = await client.request({ method, url, data });
    return response.data || {};
  } catch (error) {
    const status = Number(error.response?.status || error.code || 502);
    const providerMessage = error.response?.data?.error?.message || error.message;
    logger.warn(`Google Play API ${method} falhou (${status}): ${providerMessage}`);
    throw Object.assign(new Error(providerMessage || 'Falha na Google Play Developer API.'), {
      status: status >= 400 && status < 600 ? status : 502,
      providerData: error.response?.data,
    });
  }
}

async function getSubscriptionPurchase(purchaseToken) {
  const token = ensureValidToken(purchaseToken);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName())}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
  return publisherRequest({ url });
}

async function getSubscriptionPurchaseWithRetry(purchaseToken, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getSubscriptionPurchase(purchaseToken);
    } catch (error) {
      lastError = error;
      const retryable = [404, 409, 429, 500, 502, 503, 504].includes(Number(error.status));
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 800 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function acknowledgeSubscription(purchaseToken, productId) {
  const token = ensureValidToken(purchaseToken);
  if (!allowedProductIds().has(productId)) {
    throw Object.assign(new Error('Produto da assinatura não autorizado.'), { status: 400 });
  }
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName())}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  await publisherRequest({ method: 'POST', url, data: {} });
}

function latestExpiry(lineItems = []) {
  let latest = 0;
  for (const item of lineItems) latest = Math.max(latest, toMillis(item?.expiryTime));
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function normalizePurchase(purchase = {}, requestedProductId = null, now = new Date()) {
  const lineItems = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  const productIds = lineItems.map(item => String(item?.productId || '')).filter(Boolean);
  const allowed = allowedProductIds();
  const productId = requestedProductId && productIds.includes(requestedProductId)
    ? requestedProductId
    : productIds.find(id => allowed.has(id));

  if (!productId || !allowed.has(productId)) {
    throw Object.assign(new Error('A compra não corresponde a um produto Pro autorizado.'), { status: 409 });
  }

  const plan = productToPlan(productId);
  const expiryTime = latestExpiry(lineItems.filter(item => item?.productId === productId));
  const expiryMs = toMillis(expiryTime);
  const state = String(purchase.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED');
  const activeStates = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    'SUBSCRIPTION_STATE_CANCELED',
  ]);
  const entitled = activeStates.has(state) && expiryMs > now.getTime();
  const lineItem = lineItems.find(item => item?.productId === productId) || {};
  const autoRenewing = Boolean(lineItem.autoRenewingPlan?.autoRenewEnabled);
  const acknowledgementState = String(purchase.acknowledgementState || 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED');

  return {
    productId,
    plan,
    expiryTime,
    state,
    entitled,
    autoRenewing,
    acknowledgementState,
    acknowledged: acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    latestOrderId: purchase.latestOrderId || null,
    linkedPurchaseToken: purchase.linkedPurchaseToken || null,
    expiredPurchaseToken: purchase.outOfAppPurchaseContext?.expiredPurchaseToken || null,
    startTime: purchase.startTime || null,
    testPurchase: Boolean(purchase.testPurchase),
    regionCode: purchase.regionCode || null,
  };
}

function fallbackPlanForOtherEntitlements(profile = {}, now = new Date()) {
  if (toMillis(profile.proManualExpiresAt) > now.getTime()) return 'manual';
  if (toMillis(profile.proPrizeExpiresAt) > now.getTime()) return 'ranking-prize';
  if (toMillis(profile.proReferralExpiresAt) > now.getTime()) return 'referral';
  if (toMillis(profile.legacyProExpiresAt) > now.getTime()) return profile.proPlan || 'legacy';
  return null;
}

/**
 * Recalcula o direito da Google Play usando todos os tokens conhecidos do
 * usuário. Isso impede que a reconciliação de um token antigo encurte uma
 * assinatura mais nova ou anual.
 */
async function recomputeGooglePlayEntitlementForUser(db, uid, now = new Date()) {
  const userRef = db.collection('users').doc(uid);
  const purchasesQuery = db.collection('google_play_purchases').where('uid', '==', uid);
  let result = null;

  await db.runTransaction(async transaction => {
    const [userSnap, purchasesSnap] = await Promise.all([
      transaction.get(userRef),
      transaction.get(purchasesQuery),
    ]);
    if (!userSnap.exists) throw Object.assign(new Error('Conta do usuário não encontrada.'), { status: 404 });

    const profile = userSnap.data() || {};
    const records = purchasesSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
    const best = activePurchaseRecord(records, now);
    const latest = latestPurchaseRecord(records);
    const reference = best || latest || {};
    const otherPlan = fallbackPlanForOtherEntitlements(profile, now);
    const otherProvider = otherPlan === 'manual'
      ? 'manual'
      : otherPlan === 'ranking-prize'
        ? 'ranking'
        : otherPlan === 'referral'
          ? 'referral'
          : otherPlan
            ? 'legacy'
            : null;

    const sourcePatch = {
      googlePlayProductId: reference.productId || null,
      googlePlayPurchaseTokenHash: reference.purchaseTokenHash || null,
      googlePlayLatestOrderId: reference.latestOrderId || null,
      googlePlaySubscriptionState: reference.state || null,
      googlePlayAcknowledgementState: reference.acknowledgementState || null,
      googlePlayAutoRenewing: best?.autoRenewing === true,
      googlePlayTestPurchase: reference.testPurchase === true,
      googlePlayExpiresAt: best?.expiryTime || null,
      googlePlayEntitled: Boolean(best),
      googlePlayLastVerifiedAt: now.toISOString(),
      proBillingProvider: best ? 'google_play' : otherProvider,
      proSubscriptionId: best?.productId || null,
      proSubscriptionStatus: reference.state || null,
      proPlan: best?.plan || otherPlan,
      proCancelled: best
        ? (!best.autoRenewing || best.state === 'SUBSCRIPTION_STATE_CANCELED')
        : Boolean(latest && !otherPlan),
      proCancelledAt: best?.state === 'SUBSCRIPTION_STATE_CANCELED'
        ? (profile.proCancelledAt || now.toISOString())
        : null,
    };

    const effectiveUpdate = buildEffectiveProUpdate(profile, sourcePatch, now);
    transaction.set(userRef, effectiveUpdate, { merge: true });
    result = { best, latest, effectiveUpdate };
  });

  return result;
}

async function syncPurchaseForUser(db, uid, purchaseToken, summary, options = {}) {
  const token = ensureValidToken(purchaseToken);
  const purchaseRef = db.collection('google_play_purchases').doc(tokenHash(token));
  const userRef = db.collection('users').doc(uid);
  const now = options.now || new Date();

  await db.runTransaction(async transaction => {
    const [purchaseSnap, userSnap] = await Promise.all([
      transaction.get(purchaseRef),
      transaction.get(userRef),
    ]);

    const existingPurchase = purchaseSnap.data() || {};
    if (existingPurchase.uid && existingPurchase.uid !== uid) {
      throw Object.assign(new Error('Esta compra já está vinculada a outra conta.'), { status: 409 });
    }
    if (!userSnap.exists) throw Object.assign(new Error('Conta do usuário não encontrada.'), { status: 404 });

    transaction.set(purchaseRef, {
      uid,
      purchaseToken: token,
      purchaseTokenHash: tokenHash(token),
      productId: summary.productId,
      plan: summary.plan,
      state: summary.state,
      entitled: summary.entitled,
      expiryTime: summary.expiryTime,
      autoRenewing: summary.autoRenewing,
      acknowledgementState: summary.acknowledgementState,
      latestOrderId: summary.latestOrderId,
      linkedPurchaseTokenHash: summary.linkedPurchaseToken ? tokenHash(summary.linkedPurchaseToken) : null,
      expiredPurchaseTokenHash: summary.expiredPurchaseToken ? tokenHash(summary.expiredPurchaseToken) : null,
      testPurchase: summary.testPurchase,
      regionCode: summary.regionCode,
      updatedAt: now.toISOString(),
      createdAt: existingPurchase.createdAt || now.toISOString(),
    }, { merge: true });
  });

  await recomputeGooglePlayEntitlementForUser(db, uid, now);
  return purchaseRef;
}

async function markPurchaseAcknowledged(db, uid, purchaseToken) {
  const hash = tokenHash(purchaseToken);
  await db.collection('google_play_purchases').doc(hash).set({
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    acknowledgedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  await recomputeGooglePlayEntitlementForUser(db, uid, new Date());
}

async function verifyAndSyncPurchase(db, uid, purchaseToken, requestedProductId = null, options = {}) {
  const token = ensureValidToken(purchaseToken);
  const purchase = options.purchase || await getSubscriptionPurchaseWithRetry(token);
  const summary = normalizePurchase(purchase, requestedProductId, options.now || new Date());

  if (summary.linkedPurchaseToken) {
    const linkedSnap = await db.collection('google_play_purchases').doc(tokenHash(summary.linkedPurchaseToken)).get();
    const linked = linkedSnap.data() || {};
    if (linked.uid && linked.uid !== uid) {
      throw Object.assign(new Error('A assinatura anterior pertence a outra conta.'), { status: 409 });
    }
  }

  await syncPurchaseForUser(db, uid, token, summary, options);

  if (summary.entitled && !summary.acknowledged) {
    try {
      await acknowledgeSubscription(token, summary.productId);
      summary.acknowledged = true;
      summary.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      await markPurchaseAcknowledged(db, uid, token);
    } catch (error) {
      // Uma resposta 409 pode ocorrer se outro processo reconheceu a compra ao mesmo tempo.
      if (Number(error.status) !== 409) throw error;
      const refreshed = normalizePurchase(await getSubscriptionPurchase(token), summary.productId);
      if (!refreshed.acknowledged) throw error;
      summary.acknowledged = true;
      summary.acknowledgementState = refreshed.acknowledgementState;
      await markPurchaseAcknowledged(db, uid, token);
    }
  }

  return summary;
}

async function verifyRtdnOidcToken(authorizationHeader) {
  const token = String(authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  const audience = String(process.env.GOOGLE_PLAY_RTDN_AUDIENCE || '').trim();
  const expectedEmail = String(process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT || '').trim().toLowerCase();
  if (!token || !audience || !expectedEmail) {
    throw Object.assign(new Error('Autenticação RTDN não configurada.'), { status: 503 });
  }

  if (!rtdnVerifier) rtdnVerifier = new OAuth2Client();
  const ticket = await rtdnVerifier.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload() || {};
  if (payload.email_verified !== true || String(payload.email || '').toLowerCase() !== expectedEmail) {
    throw Object.assign(new Error('Origem da notificação RTDN não autorizada.'), { status: 401 });
  }
  return payload;
}

function decodeRtdnEnvelope(body = {}) {
  const message = body.message || {};
  const encoded = String(message.data || '');
  if (!encoded) throw Object.assign(new Error('Notificação RTDN sem dados.'), { status: 400 });

  let data;
  try {
    data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw Object.assign(new Error('Conteúdo RTDN inválido.'), { status: 400 });
  }

  if (String(data.packageName || '') !== packageName()) {
    throw Object.assign(new Error('Pacote da notificação não corresponde ao aplicativo.'), { status: 400 });
  }

  return {
    messageId: String(message.messageId || message.message_id || tokenHash(encoded)),
    publishTime: message.publishTime || null,
    data,
  };
}

async function resolveUidForPurchase(db, purchaseToken, purchase) {
  const direct = await db.collection('google_play_purchases').doc(tokenHash(purchaseToken)).get();
  if (direct.exists && direct.data()?.uid) return direct.data().uid;
  if (purchase?.linkedPurchaseToken) {
    const linked = await db.collection('google_play_purchases').doc(tokenHash(purchase.linkedPurchaseToken)).get();
    if (linked.exists && linked.data()?.uid) return linked.data().uid;
  }
  const expiredPurchaseToken = purchase?.outOfAppPurchaseContext?.expiredPurchaseToken;
  if (expiredPurchaseToken) {
    const expired = await db.collection('google_play_purchases').doc(tokenHash(expiredPurchaseToken)).get();
    if (expired.exists && expired.data()?.uid) return expired.data().uid;
  }
  return null;
}

async function reconcileStoredPurchases(db, limit = 100) {
  const snap = await db.collection('google_play_purchases').limit(Math.min(500, Math.max(1, Number(limit) || 100))).get();
  let checked = 0;
  let updated = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const entry = doc.data() || {};
    if (!entry.uid || !entry.purchaseToken) continue;
    checked += 1;
    try {
      await verifyAndSyncPurchase(db, entry.uid, entry.purchaseToken, entry.productId || null);
      updated += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`Reconciliação Google Play falhou para ${doc.id}: ${error.message}`);
    }
  }
  return { checked, updated, failed };
}

module.exports = {
  DEFAULT_PACKAGE_NAME,
  DEFAULT_PRODUCTS,
  packageName,
  productConfig,
  productToPlan,
  tokenHash,
  normalizePurchase,
  getSubscriptionPurchase,
  getSubscriptionPurchaseWithRetry,
  acknowledgeSubscription,
  activePurchaseRecord,
  latestPurchaseRecord,
  recomputeGooglePlayEntitlementForUser,
  syncPurchaseForUser,
  verifyAndSyncPurchase,
  verifyRtdnOidcToken,
  decodeRtdnEnvelope,
  resolveUidForPurchase,
  reconcileStoredPurchases,
};
