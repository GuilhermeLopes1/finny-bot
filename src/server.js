/**
 * Allo API — pagamentos, IA, importação e notificações
 */

require('dotenv').config();

const webpush = require('web-push');
const cron    = require('node-cron');



const express = require('express');
const morgan = require('morgan');

// ── VAPID Push Notifications ──
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:contato@allofinancas.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID não configurado: notificações push ficarão desativadas.');
}
const cors = require('cors');
const crypto = require('crypto');
const { verifyMercadoPagoSignature, webhookEventId } = require('./utils/mercadoPagoWebhook');
const { dateKey: saoPauloDateKey, monthKey: saoPauloMonthKey, previousMonthKey, extendExpiry } = require('./utils/saoPaulo');
const { requestLimiter } = require('./middleware/requestLimiter');
require('./config/firebase');
const { handleHealthCheck } = require('./controllers/healthController');
const logger = require('./utils/logger');
const { handleAllofyChat, getAllofyHistory, clearAllofyHistory } = require('./controllers/allofyController');
const { handlePdfImport, handleAiAnalysis } = require('./controllers/aiController');
const { requireFirebaseUser } = require('./middleware/firebaseAuth');
const { aiRateLimiter } = require('./middleware/aiRateLimiter');
const { runNotificationCycle, sendPushToProfile, hasNotificationTarget } = require('./services/notificationService');

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

const configuredOrigins = String(process.env.ALLOWED_ORIGINS || 'https://allofinancas.com,https://www.allofinancas.com')
  .split(',').map(x => x.trim()).filter(Boolean);
if (process.env.NODE_ENV !== 'production') configuredOrigins.push('http://localhost:3000', 'http://127.0.0.1:5500');
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem não autorizada pelo CORS'));
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// PDF IMPORT ROUTE
// ─────────────────────────────────────────────
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const requireAiUser = requireFirebaseUser({ requirePro: true });
const requireAllofyUser = requireFirebaseUser({ requirePro: true, dataKeys: [
  'transactions','banks','cards','categories','goals','debts','benefits','cofres',
  'uberJornadas','uberCorridas','uberGastos','uberAbastec','uberVeiculos','cardTransactions'
] });
const requireSignedInUser = requireFirebaseUser();
app.post('/import-pdf', requireAiUser, aiRateLimiter('import'), upload.single('file'), handlePdfImport);

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SISTEMA DE PLANOS MODULAR — Allo Finanças
// ─────────────────────────────────────────────
//
// PLANOS:
//   free              → gratuito (sem isPro, sem módulos)
//   motorista-monthly / motorista-yearly  → gratuito + módulo motorista
//   pro-monthly       / pro-yearly        → financeiro pessoal completo
//   proplus-monthly   / proplus-yearly    → Pro + Motorista
//
// Campos gravados no Firestore:
//   isPro              → true se plano pro ou pro+
//   isMotorista        → true se motorista ou pro+
//   proPlan            → ID do plano (ex: 'pro-monthly')
//   proExpiresAt       → expiração geral
//   motoristaExpiresAt → expiração motorista
// ─────────────────────────────────────────────

const PLANOS_DEF = {
  // ── Motorista (gratuito + motorista) ──
  'motorista-monthly': { isPro:false, isMotorista:true,  dias:30,  label:'Motorista Mensal' },
  'motorista-yearly':  { isPro:false, isMotorista:true,  dias:365, label:'Motorista Anual'  },

// ── Pro (financeiro pessoal completo) ──
  'pro-monthly':             { isPro:true,  isMotorista:false, dias:30,  label:'Pro Mensal'              },
  'pro-yearly':              { isPro:true,  isMotorista:false, dias:365, label:'Pro Anual'               },

  // ── Pro Motorista (Pro + Motorista) ──
  'pro-motorista-monthly':   { isPro:true,  isMotorista:true,  dias:30,  label:'Pro Motorista Mensal'    },
  'pro-motorista-yearly':    { isPro:true,  isMotorista:true,  dias:365, label:'Pro Motorista Anual'     },

  // ── Pro+ (tudo liberado) ──
  'proplus-monthly':         { isPro:true,  isMotorista:true,  dias:30,  label:'Pro+ Mensal'             },
  'proplus-yearly':          { isPro:true,  isMotorista:true,  dias:365, label:'Pro+ Anual'              },

  // Retrocompatibilidade com planos antigos
  'monthly': { isPro:true,  isMotorista:false, dias:30,  label:'Pro Mensal (legado)' },
  'yearly':  { isPro:true,  isMotorista:false, dias:365, label:'Pro Anual (legado)'  },
};

// Busca preço do plano no Firestore (respeita promoções)
async function getPlanPrice(plan, pricing) {
  const promoAtiva = pricing.promoExpires && new Date(pricing.promoExpires) > new Date();
  const defaults = {
    'motorista-monthly': pricing.motorista        || 9.90,
    'motorista-yearly':  pricing.motoristaYearly  || 89.90,
    'pro-monthly':             promoAtiva && pricing.promoMonthly ? pricing.promoMonthly : (pricing.monthly       || 19.90),
    'pro-yearly':              promoAtiva && pricing.promoYearly  ? pricing.promoYearly  : (pricing.yearly        || 189.90),
    'pro-motorista-monthly':   pricing.proMotorista       || 24.90,
    'pro-motorista-yearly':    pricing.proMotoristaYearly || 229.90,
    'proplus-monthly':         pricing.proPlus            || 29.90,
    'proplus-yearly':          pricing.proPlusYearly      || 269.90,
    // legado
    'monthly':           promoAtiva && pricing.promoMonthly ? pricing.promoMonthly : (pricing.monthly  || 19.90),
    'yearly':            promoAtiva && pricing.promoYearly  ? pricing.promoYearly  : (pricing.yearly   || 189.90),
  };
  return defaults[plan] || 9.90;
}

// Monta o objeto Firestore para ativar um plano
// Busca pricing sempre fresco do Firestore
async function fetchPricing(db) {
  try {
    const doc = await db.collection('settings').doc('pricing').get();
    return doc.exists ? doc.data() : {};
  } catch(e) {
    console.warn('fetchPricing error:', e.message);
    return {};
  }
}

// Monta o objeto Firestore para ativar um plano
async function buildPlanUpdate(plan, subId, db, userId) {
  const def = PLANOS_DEF[plan];
  if (!def) return null;

  const now = new Date();
  let current = {};
  if (db && userId) {
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) throw Object.assign(new Error('Usuário do pagamento não encontrado'), { status: 404 });
    current = snap.data() || {};
  }

  const update = {
    proPlan: plan,
    proSince: current.proSince || now.toISOString(),
    proCancelled: false,
    proSubscriptionStatus: subId ? 'authorized' : (current.proSubscriptionStatus || null),
    updatedAt: now.toISOString(),
    ...(subId ? { proSubscriptionId: String(subId) } : {}),
  };

  if (def.isPro) {
    update.isPro = true;
    update.proExpiresAt = extendExpiry(current.proExpiresAt, def.dias, now);
  }
  if (def.isMotorista) {
    update.isMotorista = true;
    update.motoristaExpiresAt = extendExpiry(current.motoristaExpiresAt, def.dias, now);
  }
  return update;
}

function parseExternalReference(value) {
  const [userId, plan, ...extra] = String(value || '').split('|');
  if (!userId || !plan || extra.length || !PLANOS_DEF[plan]) return null;
  return { userId, plan };
}

function assertMercadoPagoConfigured() {
  if (!process.env.MP_ACCESS_TOKEN) {
    throw Object.assign(new Error('Mercado Pago não configurado no servidor'), { status: 503 });
  }
}

async function mercadoPagoRequest(path, options = {}) {
  assertMercadoPagoConfigured();
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.message || data?.error || `Mercado Pago respondeu ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, providerData: data });
  }
  return data;
}

function paymentNotificationUrl() {
  const base = String(process.env.PUBLIC_API_URL || 'https://finny-bot.onrender.com').replace(/\/$/, '');
  return `${base}/webhook-mp`;
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ROTA PÚBLICA — PREÇOS (usada pelo planos.html)
// ─────────────────────────────────────────────
app.get('/pricing', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { getDb } = require('./config/firebase');
    const pricing = await fetchPricing(getDb());
    res.json(pricing);
  } catch(e) {
    res.json({});
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — ROTAS AUTENTICADAS E WEBHOOK
// ─────────────────────────────────────────────
const paymentLimiter = requestLimiter({ windowMs: 60_000, max: 8 });
const pointsLimiter = requestLimiter({ windowMs: 60_000, max: 20 });

app.post('/create-payment', requireSignedInUser, paymentLimiter, async (req, res) => {
  try {
    const plan = String(req.body?.plan || '');
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: 'Plano inválido.' });
    const userId = req.userIdentity.uid;
    const userEmail = String(req.userIdentity.email || req.userData?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) return res.status(409).json({ error: 'Sua conta precisa ter um e-mail válido.' });

    const { getDb } = require('./config/firebase');
    const db = getDb();
    const price = await getPlanPrice(plan, await fetchPricing(db));
    const def = PLANOS_DEF[plan];
    const yearly = plan.endsWith('-yearly') || plan === 'yearly';
    const data = await mercadoPagoRequest('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `Allo Finanças — ${def.label}`,
        external_reference: `${userId}|${plan}`,
        payer_email: userEmail,
        auto_recurring: {
          frequency: yearly ? 12 : 1,
          frequency_type: 'months',
          transaction_amount: price,
          currency_id: 'BRL',
        },
        back_url: 'https://allofinancas.com/app?payment=success',
        status: 'pending',
        notification_url: paymentNotificationUrl(),
      }),
    });
    if (!data.init_point) throw new Error('Mercado Pago não devolveu a URL de pagamento.');
    res.json({ url: data.init_point, plan: def.label, price });
  } catch (error) {
    logger.error(`create-payment: ${error.message}`);
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: 'Não foi possível iniciar a assinatura.' });
  }
});

app.post('/create-payment-pix', requireSignedInUser, paymentLimiter, async (req, res) => {
  try {
    const plan = String(req.body?.plan || '');
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: 'Plano inválido.' });
    const userId = req.userIdentity.uid;
    const userEmail = String(req.userIdentity.email || req.userData?.email || '').trim().toLowerCase();
    const userName = String(req.userData?.name || '').trim().slice(0, 100);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) return res.status(409).json({ error: 'Sua conta precisa ter um e-mail válido.' });

    const { getDb } = require('./config/firebase');
    const db = getDb();
    const price = await getPlanPrice(plan, await fetchPricing(db));
    const def = PLANOS_DEF[plan];
    const data = await mercadoPagoRequest('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ title: `Allo Finanças — ${def.label}`, quantity: 1, currency_id: 'BRL', unit_price: price }],
        payer: { email: userEmail, ...(userName ? { name: userName } : {}) },
        external_reference: `${userId}|${plan}`,
        back_urls: {
          success: 'https://allofinancas.com/app?payment=success',
          failure: 'https://allofinancas.com/app?payment=failure',
          pending: 'https://allofinancas.com/app?payment=pending',
        },
        auto_return: 'approved',
        statement_descriptor: 'Allo Financas',
        notification_url: paymentNotificationUrl(),
        payment_methods: { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }] },
      }),
    });
    if (!data.init_point) throw new Error('Mercado Pago não devolveu a URL de pagamento.');
    res.json({ url: data.init_point, plan: def.label, price });
  } catch (error) {
    logger.error(`create-payment-pix: ${error.message}`);
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: 'Não foi possível gerar o pagamento.' });
  }
});

app.post('/cancel-subscription', requireSignedInUser, paymentLimiter, async (req, res) => {
  try {
    const userId = req.userIdentity.uid;
    const { getDb } = require('./config/firebase');
    const db = getDb();
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const subscriptionId = String(userData.proSubscriptionId || '');
    if (!subscriptionId) return res.status(400).json({ error: 'Nenhuma assinatura ativa.' });

    const subscription = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(subscriptionId)}`);
    const reference = parseExternalReference(subscription.external_reference);
    if (!reference || reference.userId !== userId) return res.status(403).json({ error: 'Esta assinatura não pertence à conta autenticada.' });

    const updated = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(subscriptionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'canceled' }),
    });
    if (!['canceled', 'cancelled'].includes(String(updated.status || ''))) throw new Error('O cancelamento não foi confirmado.');

    await db.collection('users').doc(userId).set({
      proCancelled: true,
      proCancelledAt: new Date().toISOString(),
      proSubscriptionStatus: 'canceled',
    }, { merge: true });
    res.json({ success: true });
  } catch (error) {
    logger.error(`cancel-subscription: ${error.message}`);
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: 'Não foi possível cancelar a assinatura.' });
  }
});

async function claimWebhookEvent(db, eventId, metadata) {
  const ref = db.collection('mp_webhook_events').doc(eventId);
  return db.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const current = snap.data() || {};
    if (current.status === 'processed' || current.status === 'ignored') return false;
    const lastAttempt = new Date(current.updatedAt || 0).getTime();
    if (current.status === 'processing' && Date.now() - lastAttempt < 5 * 60_000) return false;
    transaction.set(ref, {
      ...metadata,
      status: 'processing',
      attempts: Number(current.attempts || 0) + 1,
      updatedAt: new Date().toISOString(),
      createdAt: current.createdAt || new Date().toISOString(),
    }, { merge: true });
    return true;
  });
}

async function finishWebhookEvent(db, eventId, status, details = {}) {
  await db.collection('mp_webhook_events').doc(eventId).set({
    status,
    ...details,
    updatedAt: new Date().toISOString(),
    ...(status === 'processed' || status === 'ignored' ? { processedAt: new Date().toISOString() } : {}),
  }, { merge: true });
}

async function validatePaymentValue(db, payment, plan) {
  const expected = Number(await getPlanPrice(plan, await fetchPricing(db)));
  const received = Number(payment.transaction_amount ?? payment.auto_recurring?.transaction_amount);
  const currency = String(payment.currency_id || payment.auto_recurring?.currency_id || '');
  if (currency && currency !== 'BRL') throw new Error('Moeda divergente no pagamento.');
  if (Number.isFinite(received) && Math.abs(received - expected) > 0.02) throw new Error('Valor divergente no pagamento.');
}

app.post('/webhook-mp', async (req, res) => {
  const dataId = req.body?.data?.id ?? req.query?.['data.id'] ?? req.body?.id;
  const type = String(req.body?.type || req.body?.topic || req.query?.type || req.query?.topic || '');
  const action = String(req.body?.action || '');
  const validSignature = verifyMercadoPagoSignature({
    signature: req.get('x-signature'),
    requestId: req.get('x-request-id'),
    dataId,
    secret: process.env.MP_WEBHOOK_SECRET,
  });
  if (!validSignature) return res.status(401).json({ error: 'Assinatura do webhook inválida.' });
  if (!dataId || !type) return res.status(400).json({ error: 'Webhook sem identificação.' });

  const { getDb } = require('./config/firebase');
  const db = getDb();
  const eventId = webhookEventId(type, dataId, action);
  try {
    const claimed = await claimWebhookEvent(db, eventId, { type, dataId: String(dataId), action });
    if (!claimed) return res.sendStatus(200);

    if (type === 'payment') {
      const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(dataId)}`);
      if (payment.status !== 'approved') {
        await finishWebhookEvent(db, eventId, 'ignored', { outcome: `payment_${payment.status || 'unknown'}` });
        return res.sendStatus(200);
      }
      const reference = parseExternalReference(payment.external_reference);
      if (!reference) throw new Error('Referência externa inválida.');
      await validatePaymentValue(db, payment, reference.plan);
      const update = await buildPlanUpdate(reference.plan, null, db, reference.userId);
      await db.collection('users').doc(reference.userId).set({ ...update, proPaymentId: String(dataId) }, { merge: true });
    } else if (type === 'subscription_preapproval') {
      const subscription = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(dataId)}`);
      const reference = parseExternalReference(subscription.external_reference);
      if (!reference) throw new Error('Referência da assinatura inválida.');
      const status = String(subscription.status || '');
      await db.collection('users').doc(reference.userId).set({
        proSubscriptionId: String(dataId),
        proSubscriptionStatus: status,
        ...(['canceled', 'cancelled'].includes(status) ? {
          proCancelled: true,
          proCancelledAt: new Date().toISOString(),
        } : {}),
      }, { merge: true });
    } else if (type === 'subscription_authorized_payment') {
      let authorizedPayment;
      try {
        authorizedPayment = await mercadoPagoRequest(`/authorized_payments/${encodeURIComponent(dataId)}`);
      } catch (_) {
        authorizedPayment = {};
      }
      const subscriptionId = authorizedPayment.preapproval_id || authorizedPayment.subscription_id || dataId;
      const subscription = await mercadoPagoRequest(`/preapproval/${encodeURIComponent(subscriptionId)}`);
      const reference = parseExternalReference(authorizedPayment.external_reference || subscription.external_reference);
      if (!reference) throw new Error('Referência da renovação inválida.');
      if (authorizedPayment.status && !['approved', 'authorized'].includes(authorizedPayment.status)) {
        await finishWebhookEvent(db, eventId, 'ignored', { outcome: `authorized_payment_${authorizedPayment.status}` });
        return res.sendStatus(200);
      }
      await validatePaymentValue(db, authorizedPayment, reference.plan);
      const update = await buildPlanUpdate(reference.plan, subscriptionId, db, reference.userId);
      await db.collection('users').doc(reference.userId).set(update, { merge: true });
    } else {
      await finishWebhookEvent(db, eventId, 'ignored', { outcome: 'unsupported_type' });
      return res.sendStatus(200);
    }

    await finishWebhookEvent(db, eventId, 'processed');
    return res.sendStatus(200);
  } catch (error) {
    logger.error(`webhook-mp ${eventId}: ${error.message}`);
    await finishWebhookEvent(db, eventId, 'failed', { error: String(error.message).slice(0, 300) }).catch(() => {});
    return res.status(500).json({ error: 'Falha temporária ao processar webhook.' });
  }
});

const ALLO_POINTS_VALUES = Object.freeze({ transaction: 10, import: 30, goal_complete: 100, daily_login: 5 });
const ALLO_POINTS_DESCRIPTIONS = Object.freeze({
  transaction: 'Transação registrada',
  import: 'Fatura importada',
  goal_complete: 'Meta concluída',
  daily_login: 'Acesso diário ao aplicativo',
  streak_7: 'Sequência de 7 dias',
});

function eventHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function findV39Item(db, uid, collection, id) {
  if (!id) return null;
  const snap = await db.collection('users').doc(uid).collection(collection).doc(String(id)).get();
  return snap.exists ? snap.data() : null;
}

async function validatePointsEvent(db, uid, profile, type, eventKey) {
  if (type === 'daily_login') return eventKey === `daily_login:${saoPauloDateKey()}`;
  if (type === 'transaction') {
    const id = eventKey.startsWith('transaction:') ? eventKey.slice(12) : '';
    const local = [...(profile.transactions || []), ...(profile.cardTransactions || [])].find(item => String(item.id) === id);
    return Boolean(local || await findV39Item(db, uid, 'transactions', id) || await findV39Item(db, uid, 'cardTransactions', id));
  }
  if (type === 'import') {
    const id = eventKey.split(':').pop();
    return Boolean((profile.importHistory || []).find(item => String(item.id) === id) || await findV39Item(db, uid, 'importHistory', id));
  }
  if (type === 'goal_complete') {
    const id = eventKey.startsWith('goal_complete:') ? eventKey.slice(14) : '';
    const goal = (profile.goals || []).find(item => String(item.id) === id) || await findV39Item(db, uid, 'goals', id);
    return Boolean(goal && (goal.status === 'completed' || Number(goal.current || 0) >= Number(goal.target || Infinity)));
  }
  return false;
}

app.post('/allopoints/award', requireSignedInUser, pointsLimiter, async (req, res) => {
  const type = String(req.body?.type || '');
  const eventKey = String(req.body?.eventKey || '').trim().slice(0, 220);
  if (!Object.prototype.hasOwnProperty.call(ALLO_POINTS_VALUES, type) || !eventKey) return res.status(400).json({ error: 'Evento de pontos inválido.' });

  const { getDb, admin } = require('./config/firebase');
  const db = getDb();
  const uid = req.userIdentity.uid;
  try {
    const fresh = await db.collection('users').doc(uid).get();
    const profile = fresh.data() || {};
    if (!await validatePointsEvent(db, uid, profile, type, eventKey)) return res.status(409).json({ error: 'O evento ainda não foi confirmado nos seus dados.' });

    const month = saoPauloMonthKey();
    const historyRef = db.collection('users').doc(uid).collection('ap_history').doc(eventHash(eventKey));
    const rankRef = db.collection('ap_ranking').doc(month).collection('users').doc(uid);
    const userRef = db.collection('users').doc(uid);
    const result = await db.runTransaction(async transaction => {
      const [historySnap, userSnap, rankSnap] = await Promise.all([
        transaction.get(historyRef), transaction.get(userRef), transaction.get(rankRef),
      ]);
      if (historySnap.exists) return { awarded: false, pointsAwarded: 0, total: Number(userSnap.data()?.alloPoints || 0) };

      const current = userSnap.data() || {};
      let pointsAwarded = ALLO_POINTS_VALUES[type];
      let streak = Number(current.apStreak || 0);
      const userUpdate = {};
      if (type === 'daily_login') {
        const today = saoPauloDateKey();
        const yesterday = saoPauloDateKey(new Date(Date.now() - 86400000));
        streak = current.apStreakLastDate === yesterday ? streak + 1 : 1;
        userUpdate.apLastLogin = today;
        userUpdate.apStreak = streak;
        userUpdate.apStreakLastDate = today;
        if (streak % 7 === 0) pointsAwarded += 50;
      }

      const total = Number(current.alloPoints || 0) + pointsAwarded;
      const monthTotal = Number(rankSnap.data()?.points || 0) + pointsAwarded;
      transaction.set(userRef, { ...userUpdate, alloPoints: total }, { merge: true });
      transaction.set(historyRef, {
        type,
        description: ALLO_POINTS_DESCRIPTIONS[type],
        points: pointsAwarded,
        eventKey,
        monthKey: month,
        streak: type === 'daily_login' ? streak : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(rankRef, {
        points: monthTotal,
        name: profile.name || req.userIdentity.email?.split('@')[0] || 'Usuário',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { awarded: true, pointsAwarded, total, streak };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.warn(`allopoints/award: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível registrar os pontos agora.' });
  }
});

// ─────────────────────────────────────────────
// AI ANALYSIS ROUTE
// ─────────────────────────────────────────────
app.post('/ai-analysis', requireAllofyUser, aiRateLimiter('analysis'), handleAiAnalysis);


app.get('/notices', requireSignedInUser, requestLimiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
  try {
    const { getDb } = require('./config/firebase');
    const snap = await getDb().collection('admin_messages').orderBy('createdAt', 'desc').limit(100).get();
    const isPro = req.userData?.isPro === true || req.userIdentity.isAdmin === true;
    const messages = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(message => {
      if (message.target === 'user') return message.userId === req.userIdentity.uid;
      if (message.target === 'pro') return isPro;
      if (message.target === 'free') return !isPro;
      return !message.target || message.target === 'all';
    }).slice(0, 20).map(message => ({
      id: message.id,
      type: String(message.type || message.tipo || 'info').slice(0, 20),
      title: String(message.title || '').slice(0, 120),
      body: String(message.body || message.message || '').slice(0, 1000),
      target: message.target || 'all',
      promoMonthly: Number(message.promoMonthly || 0) || null,
      promoYearly: Number(message.promoYearly || 0) || null,
      promoExpires: message.promoExpires || null,
      createdAt: message.createdAt?.toDate ? message.createdAt.toDate().toISOString() : message.createdAt || null,
    }));
    res.json({ ok: true, messages });
  } catch (error) {
    logger.warn(`notices: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível carregar os avisos.' });
  }
});

// Indicação processada no servidor para impedir concessão de plano pelo cliente.
app.post('/apply-referral', async (req, res) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!token) return res.status(401).json({ error: 'Autenticação necessária' });
    if (!/^ALLO-[A-Z0-9-]+$/.test(code)) return res.status(400).json({ error: 'Código inválido' });

    const { getDb, admin } = require('./config/firebase');
    const decoded = await admin.auth().verifyIdToken(token);
    const db = getDb();
    const userRef = db.collection('users').doc(decoded.uid);
    const referralRef = db.collection('referrals').doc(code);

    const result = await db.runTransaction(async tx => {
      const [userSnap, referralSnap] = await Promise.all([tx.get(userRef), tx.get(referralRef)]);
      if (!referralSnap.exists) throw Object.assign(new Error('Código não encontrado'), { status: 404 });
      const referrerId = referralSnap.data().userId;
      if (!referrerId || referrerId === decoded.uid) throw Object.assign(new Error('Código não permitido'), { status: 400 });
      const userData = userSnap.data() || {};
      if (userData.referralProcessed) throw Object.assign(new Error('Código já utilizado'), { status: 409 });

      const referrerRef = db.collection('users').doc(referrerId);
      const referrerSnap = await tx.get(referrerRef);
      if (!referrerSnap.exists) throw Object.assign(new Error('Indicador não encontrado'), { status: 404 });
      const now = new Date();
      const trialExpires = new Date(now.getTime() + 7*86400000).toISOString();
      const referrerData = referrerSnap.data() || {};
      const currentExpiry = new Date(referrerData.proExpiresAt || 0);
      const base = currentExpiry > now ? currentExpiry : now;
      const referrerExpires = new Date(base.getTime() + 30*86400000).toISOString();

      tx.set(userRef, { isPro:true, proPlan:'trial', proSince:now.toISOString(), proExpiresAt:trialExpires, referralProcessed:true, referredBy:referrerId }, { merge:true });
      tx.set(referrerRef, { isPro:true, proPlan:referrerData.proPlan || 'referral', proExpiresAt:referrerExpires, referralCount:(referrerData.referralCount || 0)+1 }, { merge:true });
      tx.set(db.collection('admin_messages').doc(), { target:'user', userId:referrerId, type:'success', title:'🎉 Sua indicação deu frutos!', body:'Um amigo usou seu código. Você ganhou mais 1 mês de Pro.', createdAt:admin.firestore.FieldValue.serverTimestamp(), createdBy:'sistema' });
      return { referrerId, trialExpires };
    });
    res.json({ ok:true, ...result });
  } catch (e) {
    logger.warn('apply-referral:', e.message);
    res.status(e.status || 500).json({ error:e.message || 'Erro ao aplicar indicação' });
  }
});

// ─────────────────────────────────────────────
// ADMIN API — Firebase Auth e auditoria protegida
// ─────────────────────────────────────────────
async function requireAdminRequest(req, res, next) {
  try {
    const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!token) return res.status(401).json({error:'Autenticação necessária'});
    const {getDb,admin}=require('./config/firebase');
    const decoded=await admin.auth().verifyIdToken(token,true);
    const userDoc=await getDb().collection('users').doc(decoded.uid).get();
    const profile=userDoc.data()||{};
    if(profile.role!=='admin'&&decoded.admin!==true) return res.status(403).json({error:'Acesso administrativo negado'});
    req.adminIdentity={uid:decoded.uid,email:decoded.email||profile.email||'',profile};
    next();
  } catch(e) {
    logger.warn('Admin auth denied:',e.message);
    res.status(401).json({error:'Sessão administrativa inválida ou expirada'});
  }
}

async function writeAdminAudit(req,action,targetUid,outcome='success',details={}){
  try{
    const {getDb,admin}=require('./config/firebase');
    const now=new Date().toISOString();
    await getDb().collection('admin_logs').add({
      action,targetUid,outcome,details,
      adminUid:req.adminIdentity?.uid||null,
      admin:req.adminIdentity?.email||null,
      msg:`${action} · ${targetUid||'sistema'} · ${outcome}`,
      tipo:outcome==='success'?'green':'red',
      ts:now,
      createdAt:admin.firestore.FieldValue.serverTimestamp(),
    });
  }catch(e){logger.warn('Admin audit write failed:',e.message)}
}

function serializeAuthUser(user){
  return {
    uid:user.uid,email:user.email||null,displayName:user.displayName||null,
    phoneNumber:user.phoneNumber||null,photoURL:user.photoURL||null,
    emailVerified:user.emailVerified===true,disabled:user.disabled===true,
    creationTime:user.metadata?.creationTime||null,
    lastSignInTime:user.metadata?.lastSignInTime||null,
    lastRefreshTime:user.metadata?.lastRefreshTime||null,
    providers:(user.providerData||[]).map(p=>p.providerId).filter(Boolean),
    customClaims:user.customClaims||{},
  };
}

app.get('/admin/health',requireAdminRequest,async(req,res)=>{
  const {admin}=require('./config/firebase');
  res.json({ok:true,service:'Allo Admin API',projectId:admin.app().options.projectId||null,time:new Date().toISOString()});
});

app.get('/admin/users',requireAdminRequest,async(req,res)=>{
  try{
    const {admin,getDb}=require('./config/firebase');
    const limit=Math.min(200,Math.max(20,Number(req.query.limit)||100));
    const pageToken=String(req.query.pageToken||'').trim()||undefined;
    const page=await admin.auth().listUsers(limit,pageToken);
    const db=getDb();
    const refs=page.users.map(user=>db.collection('users').doc(user.uid));
    const profiles=refs.length?await db.getAll(...refs):[];
    const byUid=new Map(profiles.map(doc=>[doc.id,doc.data()||{}]));
    const users=page.users.map(authUser=>{
      const profile=byUid.get(authUser.uid)||{};
      return {
        ...serializeAuthUser(authUser),
        name:profile.name||authUser.displayName||authUser.email?.split('@')[0]||'Usuário',
        role:profile.role||null,
        isAdmin:profile.role==='admin'||profile.isAdmin===true||authUser.customClaims?.admin===true,
        isPro:profile.isPro===true,
        isMotorista:profile.isMotorista===true,
        proPlan:profile.proPlan||null,
        proExpiresAt:profile.proExpiresAt||null,
        motoristaExpiresAt:profile.motoristaExpiresAt||null,
        banned:profile.banned===true||authUser.disabled===true,
        lastActiveAt:profile.lastActiveAt||profile.lastLogin||null,
        dataSchemaVersion:Number(profile.dataSchemaVersion||0),
      };
    });
    let total=null;
    try{total=(await db.collection('users').count().get()).data().count}catch(_){total=null}
    await writeAdminAudit(req,'users.list',null,'success',{count:users.length,paginated:true});
    res.json({ok:true,count:users.length,total,users,nextPageToken:page.pageToken||null});
  }catch(e){await writeAdminAudit(req,'users.list',null,'error',{message:e.message});res.status(500).json({error:'Não foi possível listar os usuários'})}
});

app.get('/admin/users/:uid',requireAdminRequest,async(req,res)=>{
  try{
    const {admin}=require('./config/firebase');
    const user=await admin.auth().getUser(req.params.uid);
    res.json({ok:true,user:serializeAuthUser(user)});
  }catch(e){res.status(e.code==='auth/user-not-found'?404:500).json({error:'Usuário não encontrado'})}
});

app.post('/admin/users/:uid/action',requireAdminRequest,async(req,res)=>{
  const uid=String(req.params.uid||'');
  const action=String(req.body?.action||'');
  const {getDb,admin}=require('./config/firebase');
  const db=getDb();
  try{
    if(!uid) return res.status(400).json({error:'UID obrigatório'});
    const targetDoc=await db.collection('users').doc(uid).get();
    const target=targetDoc.data()||{};
    const destructive=['set-disabled','delete-account'];
    if(uid===req.adminIdentity.uid&&destructive.includes(action)) return res.status(400).json({error:'Esta ação não pode ser executada na própria conta administrativa'});
    if(target.role==='admin'&&destructive.includes(action)) return res.status(403).json({error:'Contas administrativas exigem um procedimento de segurança separado'});

    if(action==='set-disabled'){
      const disabled=req.body?.disabled===true;
      await admin.auth().updateUser(uid,{disabled});
      await db.collection('users').doc(uid).set({banned:disabled,updatedAt:new Date().toISOString()},{merge:true});
    }else if(action==='revoke-sessions'){
      await admin.auth().revokeRefreshTokens(uid);
    }else if(action==='set-email-verified'){
      await admin.auth().updateUser(uid,{emailVerified:req.body?.emailVerified===true});
    }else if(action==='update-profile'){
      const update={};
      if(typeof req.body?.displayName==='string'&&req.body.displayName.trim()) update.displayName=req.body.displayName.trim().slice(0,100);
      if(typeof req.body?.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) update.email=req.body.email.trim().toLowerCase();
      if(!Object.keys(update).length) return res.status(400).json({error:'Nenhum dado válido para atualizar'});
      const changed=await admin.auth().updateUser(uid,update);
      await db.collection('users').doc(uid).set({...(update.displayName&&{name:update.displayName}),...(update.email&&{email:update.email}),updatedAt:new Date().toISOString()},{merge:true});
      await writeAdminAudit(req,action,uid,'success',{fields:Object.keys(update)});
      return res.json({ok:true,user:serializeAuthUser(changed)});
    }else if(action==='delete-account'){
      await admin.auth().deleteUser(uid);
      if(req.body?.deleteData===true){
        const ref=db.collection('users').doc(uid);
        if(typeof db.recursiveDelete==='function') await db.recursiveDelete(ref); else await ref.delete();
      }
    }else{
      return res.status(400).json({error:'Ação administrativa inválida'});
    }
    await writeAdminAudit(req,action,uid,'success',{disabled:req.body?.disabled,deleteData:req.body?.deleteData});
    res.json({ok:true,action,uid});
  }catch(e){
    logger.error('Admin user action failed:',e);
    await writeAdminAudit(req,action,uid,'error',{message:e.message});
    const status=e.code==='auth/user-not-found'?404:e.code==='auth/email-already-exists'?409:500;
    res.status(status).json({error:e.code==='auth/email-already-exists'?'Este e-mail já pertence a outra conta':'A ação administrativa não pôde ser concluída'});
  }
});
/**
 * Health check
 */
app.get('/health', handleHealthCheck);
app.post('/allofy-chat', requireAllofyUser, aiRateLimiter('allofy'), handleAllofyChat);
app.get('/allofy-history', requireAiUser, getAllofyHistory);
app.delete('/allofy-history', requireAiUser, clearAllofyHistory);
app.get('/', (req, res) => res.json({ service: 'Allo API', status: 'running' }));

// ═══════════════════════════════════════════════════
// NOTIFICAÇÕES PERSONALIZADAS
// ═══════════════════════════════════════════════════


function validNativeInstallId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

function validFcmToken(value) {
  const token = String(value || '').trim();
  return token.length >= 50 && token.length <= 4096 && !/\s/.test(token);
}

function nativeDeviceDocumentId(installId) {
  return crypto.createHash('sha256').update(String(installId)).digest('hex').slice(0, 48);
}

async function saveDeviceOnUser(userId, installId, device) {
  const { getDb } = require('./config/firebase');
  const db = getDb();
  const userRef = db.collection('users').doc(userId);
  const snap = await userRef.get();
  const current = snap.data() || {};
  const fcmDevices = current.fcmDevices && typeof current.fcmDevices === 'object' && !Array.isArray(current.fcmDevices)
    ? { ...current.fcmDevices }
    : {};
  fcmDevices[installId] = {
    token: device.token,
    platform: 'android',
    appVersion: String(device.appVersion || ''),
    updatedAt: new Date().toISOString(),
  };
  await userRef.set({
    fcmDevices,
    fcmUpdatedAt: new Date().toISOString(),
  }, { merge: true });
}

async function removeDeviceFromUser(userId, installId) {
  if (!userId) return;
  const { getDb } = require('./config/firebase');
  const db = getDb();
  const userRef = db.collection('users').doc(userId);
  const snap = await userRef.get();
  if (!snap.exists) return;
  const current = snap.data() || {};
  const fcmDevices = current.fcmDevices && typeof current.fcmDevices === 'object' && !Array.isArray(current.fcmDevices)
    ? { ...current.fcmDevices }
    : {};
  if (!Object.prototype.hasOwnProperty.call(fcmDevices, installId)) return;
  delete fcmDevices[installId];
  await userRef.set({ fcmDevices, fcmUpdatedAt: new Date().toISOString() }, { merge: true });
}

// O Android registra o token primeiro sem conhecer o usuário do navegador.
// Depois, a PWA autenticada vincula o installId à conta correta.
app.post('/notifications/native/device', async (req, res) => {
  try {
    const installId = String(req.body?.installId || '').trim();
    const token = String(req.body?.token || '').trim();
    const packageName = String(req.body?.packageName || '').trim();
    const appVersion = String(req.body?.appVersion || '').trim().slice(0, 40);

    if (!validNativeInstallId(installId) || !validFcmToken(token) || packageName !== 'com.allofinancas') {
      return res.status(400).json({ error: 'Registro de aparelho inválido.' });
    }

    const { getDb } = require('./config/firebase');
    const db = getDb();
    const ref = db.collection('notification_devices').doc(nativeDeviceDocumentId(installId));
    const previousSnap = await ref.get();
    const previous = previousSnap.data() || {};
    const device = {
      installId,
      token,
      platform: 'android',
      packageName,
      appVersion,
      userId: previous.userId || null,
      updatedAt: new Date().toISOString(),
    };

    await ref.set(device, { merge: true });
    if (device.userId) await saveDeviceOnUser(device.userId, installId, device);

    return res.json({ ok: true, bound: Boolean(device.userId) });
  } catch (error) {
    logger.warn(`Registro FCM nativo falhou: ${error.message}`);
    return res.status(500).json({ error: 'Não foi possível registrar este aparelho.' });
  }
});

app.post('/notifications/native/bind', requireSignedInUser, async (req, res) => {
  try {
    const installId = String(req.body?.installId || '').trim();
    if (!validNativeInstallId(installId)) {
      return res.status(400).json({ error: 'Identificador do aplicativo inválido.' });
    }

    const { getDb } = require('./config/firebase');
    const db = getDb();
    const ref = db.collection('notification_devices').doc(nativeDeviceDocumentId(installId));
    const snap = await ref.get();
    const device = snap.data() || {};

    if (!snap.exists || !validFcmToken(device.token)) {
      return res.status(409).json({
        error: 'O aplicativo ainda está concluindo o registro das notificações.',
        code: 'native_device_pending',
      });
    }

    const userId = req.userIdentity.uid;
    if (device.userId && device.userId !== userId) {
      await removeDeviceFromUser(device.userId, installId);
    }

    await saveDeviceOnUser(userId, installId, device);
    await ref.set({ userId, boundAt: new Date().toISOString() }, { merge: true });

    return res.json({ ok: true, channel: 'native' });
  } catch (error) {
    logger.warn(`Vínculo FCM nativo falhou: ${error.message}`);
    return res.status(500).json({ error: 'Não foi possível vincular este aparelho à conta.' });
  }
});

app.post('/notifications/test', requireSignedInUser, async (req, res) => {
  try {
    const profile = req.userData || {};
    if (!hasNotificationTarget(profile) || profile.pushEnabled === false) {
      return res.status(409).json({
        error: 'Ative as notificações no aplicativo antes de enviar o teste.',
        code: 'push_not_enabled',
      });
    }

    const sent = await sendPushToProfile(req.userIdentity.uid, profile, {
      title: '🔔 Notificações ativadas!',
      body: 'Tudo certo. O Allo Finanças já pode enviar seus resumos e alertas personalizados.',
      tag: 'notification-test',
      url: '/app?action=open-profile&via=notification',
    });

    if (!sent) return res.status(409).json({ error: 'Não foi possível usar o canal de notificações deste aparelho.' });
    res.json({ ok: true });
  } catch (error) {
    logger.warn(`Teste de push falhou: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível enviar a notificação de teste.' });
  }
});

async function executeNotificationCycle(source = 'internal') {
  const result = await runNotificationCycle(new Date());
  logger.info(`🔔 Ciclo de notificações (${source}): ${result.sent} enviada(s), ${result.failures} falha(s), ${result.users} usuário(s).`);
  return result;
}

app.post('/notifications/run', async (req, res) => {
  const expected = String(process.env.CRON_SECRET || '').trim();
  const supplied = String(req.get('x-cron-secret') || '').trim();
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET não configurado.' });
  const authorized = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!authorized) return res.status(401).json({ error: 'Acesso não autorizado.' });

  try {
    res.json({ ok: true, ...(await executeNotificationCycle('external')) });
  } catch (error) {
    logger.error(`Ciclo externo de notificações falhou: ${error.message}`);
    res.status(500).json({ error: 'Falha ao executar notificações.' });
  }
});

// Funciona enquanto o serviço está ativo. A rota /notifications/run permite
// que um Cron Job externo acorde o serviço e execute o mesmo ciclo.
cron.schedule('*/15 * * * *', () => {
  executeNotificationCycle('internal').catch(error => {
    logger.error(`Cron interno de notificações falhou: ${error.message}`);
  });
});

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});
// ─────────────────────────────────────────────
// ALLO POINTS — APURAÇÃO MENSAL RECUPERÁVEL
// ─────────────────────────────────────────────
async function claimRankingFinalization(db, monthKey) {
  const ref=db.collection('ap_ranking').doc(monthKey);
  return db.runTransaction(async transaction=>{
    const snap=await transaction.get(ref);const data=snap.data()||{};
    if(data.finalizationStatus==='processed'||data.apuratedAt)return false;
    const last=new Date(data.finalizationUpdatedAt||0).getTime();
    if(data.finalizationStatus==='processing'&&Date.now()-last<15*60_000)return false;
    transaction.set(ref,{finalizationStatus:'processing',finalizationUpdatedAt:new Date().toISOString()},{merge:true});
    return true;
  });
}

async function apurarRankingMensal(){
  const monthKey=previousMonthKey();
  const {getDb}=require('./config/firebase');
  const db=getDb();
  try{
    // Garante que o bônus do mês fechado entre no ranking antes da apuração.
    await bonusSaldoPositivo(monthKey);
    const claimed=await claimRankingFinalization(db,monthKey);
    if(!claimed)return;
    const [year,month]=monthKey.split('-').map(Number);
    const monthLabel=new Date(year,month-1,15,12).toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
    const rankSnap=await db.collection('ap_ranking').doc(monthKey).collection('users').orderBy('points','desc').limit(1).get();
    const parentRef=db.collection('ap_ranking').doc(monthKey);
    if(rankSnap.empty){
      await parentRef.set({finalizationStatus:'processed',finalizationUpdatedAt:new Date().toISOString(),apuratedAt:new Date().toISOString(),winner:null,prize:null},{merge:true});
      return;
    }
    const winner=rankSnap.docs[0];const winnerData=winner.data()||{};
    const winnerRef=db.collection('users').doc(winner.id);
    await db.runTransaction(async transaction=>{
      const [parentSnap,userSnap]=await Promise.all([transaction.get(parentRef),transaction.get(winnerRef)]);
      const parent=parentSnap.data()||{};
      if(parent.apuratedAt||parent.finalizationStatus==='processed')return;
      const user=userSnap.data()||{};const now=new Date();
      const expiresAt=extendExpiry(user.proExpiresAt,30,now);
      transaction.set(winnerRef,{
        isPro:true,
        proPlan:user.proPlan||'ranking-prize',
        proSince:user.proSince||now.toISOString(),
        proExpiresAt:expiresAt,
        proAwardedBy:'ranking',
        proAwardMonth:monthKey,
        proPrizeDays:Number(user.proPrizeDays||0)+30,
      },{merge:true});
      transaction.set(parentRef,{
        winner:{id:winner.id,name:winnerData.name||'Usuário',points:Number(winnerData.points||0)},
        apuratedAt:now.toISOString(),
        finalizationStatus:'processed',
        finalizationUpdatedAt:now.toISOString(),
        prize:'30 dias de Pro adicionados ao vencimento existente',
      },{merge:true});
    });
    await db.collection('admin_messages').add({
      target:'all',type:'success',title:`🏆 Campeão do mês de ${monthLabel}!`,
      body:`${winnerData.name||'Usuário'} venceu o ranking com ${Number(winnerData.points||0).toLocaleString('pt-BR')} Allo Points e ganhou mais 30 dias de Pro. Parabéns! 🎉`,
      createdAt:new Date(),createdBy:'sistema'
    });
  }catch(error){
    logger.error(`apurarRankingMensal ${monthKey}: ${error.message}`);
    await db.collection('ap_ranking').doc(monthKey).set({finalizationStatus:'failed',finalizationUpdatedAt:new Date().toISOString(),finalizationError:String(error.message).slice(0,250)},{merge:true}).catch(()=>{});
  }
}

// ─────────────────────────────────────────────
// ALLO POINTS — BÔNUS DO ÚLTIMO MÊS FECHADO
// ─────────────────────────────────────────────
async function bonusSaldoPositivo(monthKey=previousMonthKey()){
  try{
    const {getDb,admin}=require('./config/firebase');const db=getDb();
    const usersSnap=await db.collection('users').get();
    for(const userDoc of usersSnap.docs){
      const user=userDoc.data()||{};const uid=userDoc.id;const marker=`apBonus_${monthKey}`;
      if(user[marker])continue;
      let transactions=[];
      const txSnap=await userDoc.ref.collection('transactions').where('date','>=',`${monthKey}-01`).where('date','<=',`${monthKey}-31`).get().catch(()=>null);
      if(txSnap&&!txSnap.empty)transactions=txSnap.docs.map(doc=>doc.data());
      else transactions=(user.transactions||[]).filter(tx=>String(tx.date||'').startsWith(monthKey));
      let income=0,expense=0;
      transactions.forEach(tx=>{const amount=Number(tx.amount||0);if(tx.type==='income')income+=amount;if(tx.type==='expense')expense+=amount});
      if(!(income>0&&income>expense)){
        await userDoc.ref.set({[marker]:'not_eligible'},{merge:true});
        continue;
      }
      const historyRef=userDoc.ref.collection('ap_history').doc(eventHash(`positive_month:${monthKey}`));
      const rankRef=db.collection('ap_ranking').doc(monthKey).collection('users').doc(uid);
      await db.runTransaction(async transaction=>{
        const [freshUser,history,rank]=await Promise.all([transaction.get(userDoc.ref),transaction.get(historyRef),transaction.get(rankRef)]);
        const current=freshUser.data()||{};
        if(current[marker]||history.exists)return;
        transaction.set(userDoc.ref,{alloPoints:Number(current.alloPoints||0)+200,[marker]:true},{merge:true});
        transaction.set(historyRef,{type:'positive_month',description:'Mês com saldo positivo',points:200,monthKey,createdAt:admin.firestore.FieldValue.serverTimestamp()});
        transaction.set(rankRef,{points:Number(rank.data()?.points||0)+200,name:user.name||'Usuário',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      });
    }
  }catch(error){logger.error(`bonusSaldoPositivo ${monthKey}: ${error.message}`)}
}

// Executa ao iniciar e a cada seis horas. Se o Render dormir no dia 1, a próxima
// execução recupera automaticamente o mês anterior sem duplicar o prêmio.
setTimeout(()=>apurarRankingMensal(),5_000);
cron.schedule('20 */6 * * *',()=>apurarRankingMensal());

// ─────────────────────────────────────────────
// JOB DIÁRIO — VERIFICA EXPIRAÇÃO DO PRO
// ─────────────────────────────────────────────
async function checkProExpirations(){
  try {
    const { getDb } = require('./config/firebase');
    const db = getDb();
    const now = new Date();
    const snap = await db.collection('users').where('isPro','==',true).get();

    for(const doc of snap.docs){
      const data = doc.data();
      if(!data.proExpiresAt) continue;

      const expiresAt = new Date(data.proExpiresAt);
      const daysLeft = Math.ceil((expiresAt - now) / (1000*60*60*24));

      // Desativa se expirou
      if(daysLeft <= 0){
        await db.collection('users').doc(doc.id).set({
          isPro: false,
          proExpired: true,
          proExpiredAt: now.toISOString()
        }, { merge: true });
        console.log('❌ PRO expirado para:', doc.id);
        continue;
      }

      // Salva dias restantes para o app exibir
      await db.collection('users').doc(doc.id).set({
        proDaysLeft: daysLeft
      }, { merge: true });

      console.log('⏳ PRO:', doc.id, '- dias restantes:', daysLeft);
    }
  } catch(e){
    console.error('checkProExpirations error:', e);
  }
}

// Roda imediatamente e depois a cada 24h
checkProExpirations();
setInterval(checkProExpirations, 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`🚀 Allo API running on port ${PORT}`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info('🔔 Agendador de notificações ativo (a cada 15 minutos).');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

module.exports = app;
