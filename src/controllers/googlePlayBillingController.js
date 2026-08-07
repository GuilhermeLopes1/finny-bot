'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const { requestLimiter } = require('../middleware/requestLimiter');
const {
  packageName,
  productConfig,
  productToPlan,
  tokenHash,
  getSubscriptionPurchase,
  normalizePurchase,
  verifyAndSyncPurchase,
  verifyRtdnOidcToken,
  decodeRtdnEnvelope,
  resolveUidForPurchase,
  reconcileStoredPurchases,
} = require('../services/googlePlayBillingService');

const billingLimiter = requestLimiter({ windowMs: 60_000, max: 10 });

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicEntitlement(summary) {
  return {
    active: summary.entitled === true,
    productId: summary.productId,
    plan: summary.plan,
    state: summary.state,
    expiresAt: summary.expiryTime,
    autoRenewing: summary.autoRenewing === true,
    acknowledged: summary.acknowledged === true,
    testPurchase: summary.testPurchase === true,
  };
}


function publicBillingFailure(error) {
  const status = Number(error?.status || 0);
  const providerCode = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  const permissionDenied = [401, 403].includes(status) && (
    providerCode.includes('permission_denied') ||
    message.includes('insufficient permission') ||
    message.includes('insufficient permissions') ||
    message.includes('permission')
  );

  if (permissionDenied) {
    return {
      httpStatus: 503,
      code: 'google_play_permission_pending',
      error: 'A Google Play ainda não autorizou o servidor a consultar esta assinatura.',
      retryable: true,
    };
  }
  if (status === 404) {
    return {
      httpStatus: 409,
      code: 'google_play_purchase_not_found',
      error: 'A compra não foi encontrada nesta conta da Google Play.',
      retryable: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      httpStatus: 503,
      code: 'google_play_auth_failed',
      error: 'O servidor não conseguiu autenticar a conta de serviço da Google Play.',
      retryable: true,
    };
  }
  if (status === 409) {
    return {
      httpStatus: 409,
      code: error?.code || 'google_play_purchase_conflict',
      error: error?.message || 'A compra não pôde ser associada a esta conta.',
      retryable: false,
    };
  }
  if (status === 400) {
    return {
      httpStatus: 400,
      code: error?.code || 'google_play_invalid_purchase',
      error: 'Os dados enviados para validar a compra são inválidos.',
      retryable: false,
    };
  }
  if (status === 429 || status >= 500) {
    return {
      httpStatus: 503,
      code: 'google_play_temporarily_unavailable',
      error: 'A Google Play está temporariamente indisponível. Tente novamente mais tarde.',
      retryable: true,
    };
  }
  return {
    httpStatus: 502,
    code: 'google_play_verification_failed',
    error: 'Não foi possível confirmar a assinatura na Google Play.',
    retryable: false,
  };
}

function registerGooglePlayBillingRoutes(app, { requireSignedInUser, getDb }) {
  app.get('/google-play/config', (req, res) => {
    res.json({
      provider: 'google_play',
      packageName: packageName(),
      products: productConfig(),
      storePaymentMethod: 'https://play.google.com/billing',
    });
  });

  app.get('/google-play/status', requireSignedInUser, async (req, res) => {
    const profile = req.userData || {};
    res.json({
      ok: true,
      provider: profile.proBillingProvider || null,
      active: profile.isPro === true,
      productId: profile.googlePlayProductId || null,
      plan: profile.proPlan || null,
      state: profile.googlePlaySubscriptionState || profile.proSubscriptionStatus || null,
      expiresAt: profile.proExpiresAt || null,
      googlePlayExpiresAt: profile.googlePlayExpiresAt || null,
      autoRenewing: profile.googlePlayAutoRenewing === true,
      acknowledged: profile.googlePlayAcknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    });
  });

  app.post('/google-play/verify-subscription', requireSignedInUser, billingLimiter, async (req, res) => {
    try {
      const purchaseToken = String(req.body?.purchaseToken || '').trim();
      const productId = String(req.body?.productId || '').trim();
      if (!purchaseToken || !productToPlan(productId)) {
        return res.status(400).json({ error: 'Compra ou produto inválido.' });
      }

      const tokenPreview = tokenHash(purchaseToken).slice(0, 12);
      logger.info(`Google Play: validação iniciada uid=${req.userIdentity.uid} product=${productId} tokenHash=${tokenPreview}`);

      const summary = await verifyAndSyncPurchase(
        getDb(),
        req.userIdentity.uid,
        purchaseToken,
        productId
      );

      logger.info(`Google Play: validação concluída uid=${req.userIdentity.uid} product=${summary.productId} active=${summary.entitled} acknowledged=${summary.acknowledged}`);
      return res.json({ ok: true, entitlement: publicEntitlement(summary) });
    } catch (error) {
      const failure = publicBillingFailure(error);
      logger.warn(`Verificação Google Play falhou status=${error.status || 'n/a'} code=${error.code || 'n/a'}: ${error.message}`);
      return res.status(failure.httpStatus).json({
        error: failure.error,
        code: failure.code,
        retryable: failure.retryable,
      });
    }
  });

  app.post('/google-play/rtdn', async (req, res) => {
    let eventRef;
    try {
      await verifyRtdnOidcToken(req.get('authorization'));
      const envelope = decodeRtdnEnvelope(req.body);
      const db = getDb();
      eventRef = db.collection('google_play_rtdn_events').doc(tokenHash(envelope.messageId));
      const eventSnap = await eventRef.get();
      if (eventSnap.data()?.status === 'processed') return res.sendStatus(204);

      const notification = envelope.data.subscriptionNotification;
      if (!notification?.purchaseToken) {
        await eventRef.set({
          messageId: envelope.messageId,
          status: 'ignored',
          reason: 'notification_without_subscription',
          publishTime: envelope.publishTime,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        return res.sendStatus(204);
      }

      const purchaseToken = String(notification.purchaseToken);
      const purchase = await getSubscriptionPurchase(purchaseToken);
      const summary = normalizePurchase(purchase, notification.subscriptionId || null);
      const uid = await resolveUidForPurchase(db, purchaseToken, purchase);

      if (!uid) {
        await eventRef.set({
          messageId: envelope.messageId,
          status: 'orphaned',
          productId: summary.productId,
          purchaseTokenHash: tokenHash(purchaseToken),
          notificationType: notification.notificationType || null,
          publishTime: envelope.publishTime,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        return res.sendStatus(204);
      }

      await verifyAndSyncPurchase(db, uid, purchaseToken, summary.productId, { purchase });
      await eventRef.set({
        messageId: envelope.messageId,
        status: 'processed',
        uid,
        productId: summary.productId,
        purchaseTokenHash: tokenHash(purchaseToken),
        notificationType: notification.notificationType || null,
        publishTime: envelope.publishTime,
        processedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      return res.sendStatus(204);
    } catch (error) {
      logger.warn(`RTDN Google Play falhou: ${error.message}`);
      if (eventRef) {
        await eventRef.set({
          status: 'failed',
          error: String(error.message).slice(0, 300),
          updatedAt: new Date().toISOString(),
        }, { merge: true }).catch(() => {});
      }
      const status = Number(error.status);
      return res.status(status >= 400 && status < 500 ? status : 500).json({
        error: status === 401 ? 'Notificação não autorizada.' : 'Falha ao processar a notificação.',
      });
    }
  });

  app.post('/google-play/reconcile', async (req, res) => {
    const expected = String(process.env.CRON_SECRET || '').trim();
    const supplied = String(req.get('x-cron-secret') || '').trim();
    if (!expected) return res.status(503).json({ error: 'CRON_SECRET não configurado.' });
    if (!safeEqual(expected, supplied)) return res.status(401).json({ error: 'Acesso não autorizado.' });

    try {
      const result = await reconcileStoredPurchases(getDb(), Number(req.body?.limit) || 100);
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.error(`Reconciliação Google Play falhou: ${error.message}`);
      return res.status(500).json({ error: 'Não foi possível reconciliar as assinaturas.' });
    }
  });
}

module.exports = { registerGooglePlayBillingRoutes, publicEntitlement, publicBillingFailure };
