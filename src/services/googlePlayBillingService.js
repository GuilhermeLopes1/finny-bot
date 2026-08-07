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
const OWNERSHIP_VERSION = 2;
const DEFAULT_FRESH_PURCHASE_WINDOW_MS = 30 * 60 * 1000;

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
  // Não usar GOOGLE_CREDENTIALS como fallback: ela pertence ao Firebase Admin
  // em instalações antigas e pode apontar para outra conta de serviço.
  const raw = String(process.env.GOOGLE_PLAY_CREDENTIALS || '').trim();
  if (!raw) {
    throw Object.assign(new Error('GOOGLE_PLAY_CREDENTIALS não configurada.'), {
      status: 503,
      code: 'google_play_credentials_missing',
    });
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`GOOGLE_PLAY_CREDENTIALS contém JSON inválido: ${error.message}`), {
      status: 503,
      code: 'google_play_credentials_invalid',
    });
  }

  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  if (
    credentials.type !== 'service_account' ||
    !String(credentials.client_email || '').includes('@') ||
    !String(credentials.private_key || '').includes('BEGIN PRIVATE KEY')
  ) {
    throw Object.assign(new Error('GOOGLE_PLAY_CREDENTIALS não contém uma conta de serviço válida.'), {
      status: 503,
      code: 'google_play_credentials_invalid',
    });
  }
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

function obfuscatedAccountIdForUid(uid) {
  return crypto.createHash('sha256').update(`allofy:${String(uid || '').trim()}`).digest('hex');
}

function freshPurchaseWindowMs() {
  const minutes = Number(process.env.GOOGLE_PLAY_FRESH_PURCHASE_WINDOW_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 180) return DEFAULT_FRESH_PURCHASE_WINDOW_MS;
  return Math.round(minutes * 60 * 1000);
}

function isFreshUnacknowledgedPurchase(summary = {}, now = new Date()) {
  if (summary.acknowledged === true) return false;
  const startMs = toMillis(summary.startTime);
  if (!startMs) return false;
  const ageMs = now.getTime() - startMs;
  return ageMs >= -60_000 && ageMs <= freshPurchaseWindowMs();
}

function storedOwnerIsTrusted(record = {}) {
  return Boolean(record.uid) && Number(record.ownershipVersion || 0) >= OWNERSHIP_VERSION;
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
      code: error.response?.data?.error?.status || 'google_play_api_error',
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

async function acknowledgeSubscription(purchaseToken, productId, options = {}) {
  const token = ensureValidToken(purchaseToken);
  if (!allowedProductIds().has(productId)) {
    throw Object.assign(new Error('Produto da assinatura não autorizado.'), { status: 400 });
  }
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName())}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  const data = {};
  const obfuscatedAccountId = String(options.obfuscatedAccountId || '').trim();
  if (obfuscatedAccountId) {
    data.externalAccountIds = { obfuscatedAccountId };
  }

  try {
    await publisherRequest({ method: 'POST', url, data });
  } catch (error) {
    // A Google Play só aceita externalAccountIds em alguns fluxos de
    // re-assinatura. Se o provedor recusar apenas esse metadado, reconheça
    // novamente sem ele para não deixar uma compra legítima sem ACK.
    if (obfuscatedAccountId && Number(error.status) === 400) {
      logger.warn('Google Play recusou externalAccountIds no acknowledge; repetindo sem o identificador ofuscado.');
      await publisherRequest({ method: 'POST', url, data: {} });
      return;
    }
    throw error;
  }
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
    externalAccountId: purchase.externalAccountIdentifiers?.obfuscatedAccountId || null,
    expiredExternalAccountId: purchase.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers?.obfuscatedAccountId || null,
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
  const purchaseHash = tokenHash(token);
  const purchaseRef = db.collection('google_play_purchases').doc(purchaseHash);
  const userRef = db.collection('users').doc(uid);
  const accountId = obfuscatedAccountIdForUid(uid);
  const accountLinkRef = db.collection('google_play_account_links').doc(accountId);
  const now = options.now || new Date();
  const linkedHash = summary.linkedPurchaseToken ? tokenHash(summary.linkedPurchaseToken) : null;
  const linkedRef = linkedHash && linkedHash !== purchaseHash
    ? db.collection('google_play_purchases').doc(linkedHash)
    : null;
  let previousLinkedUid = null;
  let ownershipHandoff = false;

  await db.runTransaction(async transaction => {
    const reads = [transaction.get(purchaseRef), transaction.get(userRef)];
    if (linkedRef) reads.push(transaction.get(linkedRef));
    const snapshots = await Promise.all(reads);
    const purchaseSnap = snapshots[0];
    const userSnap = snapshots[1];
    const linkedSnap = linkedRef ? snapshots[2] : null;

    const existingPurchase = purchaseSnap.data() || {};
    const linkedPurchase = linkedSnap?.data() || {};

    if (!userSnap.exists) {
      throw Object.assign(new Error('Conta do usuário não encontrada.'), {
        status: 404,
        code: 'google_play_user_not_found',
      });
    }

    // O token atual é a chave primária do direito. Um token já vinculado nunca
    // muda de conta automaticamente, nem durante uma restauração.
    if (existingPurchase.uid && existingPurchase.uid !== uid) {
      throw Object.assign(new Error('Esta compra já está vinculada a outra conta.'), {
        status: 409,
        code: 'google_play_token_owner_mismatch',
      });
    }

    // Quando a Google Play devolve um identificador de conta ofuscado, ele é
    // uma evidência forte de titularidade e deve corresponder ao usuário atual.
    if (summary.externalAccountId && summary.externalAccountId !== accountId) {
      throw Object.assign(new Error('A identificação da conta na Google Play não corresponde à conta atual.'), {
        status: 409,
        code: 'google_play_external_account_mismatch',
      });
    }

    if (linkedPurchase.uid && linkedPurchase.uid !== uid) {
      // linkedPurchaseToken é histórico. Para não herdar para sempre um vínculo
      // legado incorreto, uma compra NOVA, ainda não reconhecida e feita há
      // poucos minutos pode ser vinculada ao UID autenticado que acabou de
      // concluir o checkout. Uma restauração antiga/ACK não recebe essa exceção.
      const allowFreshPurchaseHandoff = !existingPurchase.uid && isFreshUnacknowledgedPurchase(summary, now);
      if (!allowFreshPurchaseHandoff) {
        throw Object.assign(new Error('A assinatura anterior pertence a outra conta.'), {
          status: 409,
          code: 'google_play_linked_owner_mismatch',
        });
      }

      previousLinkedUid = linkedPurchase.uid;
      ownershipHandoff = true;
      transaction.set(linkedRef, {
        entitled: false,
        supersededByPurchaseTokenHash: purchaseHash,
        supersededAt: now.toISOString(),
        supersededReason: 'google_play_linked_purchase',
        ownershipConflictDetectedAt: now.toISOString(),
        ownershipConflictResolvedBy: 'fresh_authenticated_purchase',
        updatedAt: now.toISOString(),
      }, { merge: true });
    }

    const remainsSuperseded = Boolean(existingPurchase.supersededByPurchaseTokenHash);
    const effectiveEntitled = summary.entitled === true && !remainsSuperseded;
    const ownershipSource = existingPurchase.ownershipSource
      || options.ownershipSource
      || (ownershipHandoff ? 'fresh_authenticated_purchase' : 'authenticated_verify');

    transaction.set(purchaseRef, {
      uid,
      ownerUidHash: accountId,
      ownershipVersion: OWNERSHIP_VERSION,
      ownershipSource,
      ownershipLinkedAt: existingPurchase.ownershipLinkedAt || now.toISOString(),
      ownershipVerifiedAt: now.toISOString(),
      purchaseToken: token,
      purchaseTokenHash: purchaseHash,
      productId: summary.productId,
      plan: summary.plan,
      state: summary.state,
      entitled: effectiveEntitled,
      expiryTime: summary.expiryTime,
      autoRenewing: summary.autoRenewing,
      acknowledgementState: summary.acknowledgementState,
      latestOrderId: summary.latestOrderId,
      linkedPurchaseTokenHash: linkedHash,
      expiredPurchaseTokenHash: summary.expiredPurchaseToken ? tokenHash(summary.expiredPurchaseToken) : null,
      externalAccountId: summary.externalAccountId || null,
      expiredExternalAccountId: summary.expiredExternalAccountId || null,
      testPurchase: summary.testPurchase,
      regionCode: summary.regionCode,
      updatedAt: now.toISOString(),
      createdAt: existingPurchase.createdAt || now.toISOString(),
    }, { merge: true });

    transaction.set(accountLinkRef, {
      uid,
      obfuscatedAccountId: accountId,
      updatedAt: now.toISOString(),
      createdAt: now.toISOString(),
    }, { merge: true });
  });

  if (ownershipHandoff) {
    logger.warn(`Google Play: vínculo histórico divergente ignorado para compra nova e recente. oldUid=${previousLinkedUid} newUid=${uid} tokenHash=${purchaseHash.slice(0, 12)}`);
  }

  await recomputeGooglePlayEntitlementForUser(db, uid, now);
  if (previousLinkedUid && previousLinkedUid !== uid) {
    await recomputeGooglePlayEntitlementForUser(db, previousLinkedUid, now).catch(error => {
      logger.warn(`Google Play: não foi possível recalcular o usuário antigo após substituição: ${error.message}`);
    });
  }
  return { purchaseRef, ownershipHandoff, previousLinkedUid };
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
  const now = options.now || new Date();
  const purchase = options.purchase || await getSubscriptionPurchaseWithRetry(token);
  const summary = normalizePurchase(purchase, requestedProductId, now);

  const syncResult = await syncPurchaseForUser(db, uid, token, summary, { ...options, now });
  summary.ownershipHandoff = syncResult.ownershipHandoff === true;

  if (summary.entitled && !summary.acknowledged) {
    const isResubscription = Boolean(summary.linkedPurchaseToken || summary.expiredPurchaseToken);
    try {
      await acknowledgeSubscription(token, summary.productId, {
        obfuscatedAccountId: isResubscription ? obfuscatedAccountIdForUid(uid) : null,
      });
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

async function resolveUidByObfuscatedAccountId(db, obfuscatedAccountId) {
  const id = String(obfuscatedAccountId || '').trim();
  if (!id) return null;
  const snap = await db.collection('google_play_account_links').doc(id).get();
  return snap.exists && snap.data()?.uid ? snap.data().uid : null;
}

async function resolveUidForPurchase(db, purchaseToken, purchase) {
  const direct = await db.collection('google_play_purchases').doc(tokenHash(purchaseToken)).get();
  if (direct.exists && direct.data()?.uid) return direct.data().uid;

  const externalAccountId = purchase?.externalAccountIdentifiers?.obfuscatedAccountId;
  const externalUid = await resolveUidByObfuscatedAccountId(db, externalAccountId);
  if (externalUid) return externalUid;

  if (purchase?.linkedPurchaseToken) {
    const linked = await db.collection('google_play_purchases').doc(tokenHash(purchase.linkedPurchaseToken)).get();
    const linkedData = linked.data() || {};
    // RTDN não deve perpetuar automaticamente um vínculo legado que nunca foi
    // verificado pela política V42.2. Se não houver identificador externo e o
    // histórico for antigo, deixe a notificação órfã até o app autenticar o UID.
    if (linked.exists && storedOwnerIsTrusted(linkedData)) return linkedData.uid;
  }

  const expiredExternalAccountId = purchase?.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers?.obfuscatedAccountId;
  const expiredExternalUid = await resolveUidByObfuscatedAccountId(db, expiredExternalAccountId);
  if (expiredExternalUid) return expiredExternalUid;

  const expiredPurchaseToken = purchase?.outOfAppPurchaseContext?.expiredPurchaseToken;
  if (expiredPurchaseToken) {
    const expired = await db.collection('google_play_purchases').doc(tokenHash(expiredPurchaseToken)).get();
    const expiredData = expired.data() || {};
    if (expired.exists && storedOwnerIsTrusted(expiredData)) return expiredData.uid;
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
  obfuscatedAccountIdForUid,
  isFreshUnacknowledgedPurchase,
  storedOwnerIsTrusted,
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
  resolveUidByObfuscatedAccountId,
  resolveUidForPurchase,
  reconcileStoredPurchases,
};
