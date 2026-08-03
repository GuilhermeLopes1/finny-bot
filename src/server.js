<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>server.js completo</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#111827;color:#f9fafb}
header{position:sticky;top:0;background:#111827;padding:14px;border-bottom:1px solid #374151}
button{width:100%;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;background:#22c55e;color:#052e16}
p{font-size:13px;color:#cbd5e1;margin:10px 0 0}
pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
</head>
<body>
<header>
<button onclick="copyCode()">Copiar o código completo</button>
<p id="status">Arquivo completo: 953 linhas.</p>
</header>
<pre id="code">/**
 * Allo API — pagamentos, IA, importação e notificações
 */

require(&#x27;dotenv&#x27;).config();

const webpush = require(&#x27;web-push&#x27;);
const cron    = require(&#x27;node-cron&#x27;);



const express = require(&#x27;express&#x27;);
const morgan = require(&#x27;morgan&#x27;);

// ── VAPID Push Notifications ──
if (process.env.VAPID_PUBLIC_KEY &amp;&amp; process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(&#x27;mailto:contato@allofinancas.com&#x27;, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
} else {
  console.warn(&#x27;VAPID não configurado: notificações push ficarão desativadas.&#x27;);
}
const cors = require(&#x27;cors&#x27;);
const crypto = require(&#x27;crypto&#x27;);
require(&#x27;./config/firebase&#x27;);
const { handleHealthCheck } = require(&#x27;./controllers/healthController&#x27;);
const logger = require(&#x27;./utils/logger&#x27;);
const { handleAllofyChat, getAllofyHistory, clearAllofyHistory } = require(&#x27;./controllers/allofyController&#x27;);
const { handlePdfImport, handleAiAnalysis } = require(&#x27;./controllers/aiController&#x27;);
const { requireFirebaseUser } = require(&#x27;./middleware/firebaseAuth&#x27;);
const { aiRateLimiter } = require(&#x27;./middleware/aiRateLimiter&#x27;);
const { runNotificationCycle, sendPushToProfile } = require(&#x27;./services/notificationService&#x27;);

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

const configuredOrigins = String(process.env.ALLOWED_ORIGINS || &#x27;https://allofinancas.com,https://www.allofinancas.com&#x27;)
  .split(&#x27;,&#x27;).map(x =&gt; x.trim()).filter(Boolean);
if (process.env.NODE_ENV !== &#x27;production&#x27;) configuredOrigins.push(&#x27;http://localhost:3000&#x27;, &#x27;http://127.0.0.1:5500&#x27;);
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(&#x27;Origem não autorizada pelo CORS&#x27;));
  },
  allowedHeaders: [&#x27;Content-Type&#x27;, &#x27;Authorization&#x27;],
  methods: [&#x27;GET&#x27;, &#x27;POST&#x27;, &#x27;DELETE&#x27;, &#x27;OPTIONS&#x27;],
}));
app.use(express.json({ limit: &#x27;10mb&#x27; }));
app.use(express.urlencoded({ extended: true, limit: &#x27;10mb&#x27; }));
app.use(morgan(&#x27;combined&#x27;, { stream: { write: (msg) =&gt; logger.info(msg.trim()) } }));

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// PDF IMPORT ROUTE
// ─────────────────────────────────────────────
const multer = require(&#x27;multer&#x27;);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const requireAiUser = requireFirebaseUser({ requirePro: true });
const requireSignedInUser = requireFirebaseUser();
app.post(&#x27;/import-pdf&#x27;, requireAiUser, aiRateLimiter(&#x27;import&#x27;), upload.single(&#x27;file&#x27;), handlePdfImport);

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
//   proPlan            → ID do plano (ex: &#x27;pro-monthly&#x27;)
//   proExpiresAt       → expiração geral
//   motoristaExpiresAt → expiração motorista
// ─────────────────────────────────────────────

const PLANOS_DEF = {
  // ── Motorista (gratuito + motorista) ──
  &#x27;motorista-monthly&#x27;: { isPro:false, isMotorista:true,  dias:30,  label:&#x27;Motorista Mensal&#x27; },
  &#x27;motorista-yearly&#x27;:  { isPro:false, isMotorista:true,  dias:365, label:&#x27;Motorista Anual&#x27;  },

// ── Pro (financeiro pessoal completo) ──
  &#x27;pro-monthly&#x27;:             { isPro:true,  isMotorista:false, dias:30,  label:&#x27;Pro Mensal&#x27;              },
  &#x27;pro-yearly&#x27;:              { isPro:true,  isMotorista:false, dias:365, label:&#x27;Pro Anual&#x27;               },

  // ── Pro Motorista (Pro + Motorista) ──
  &#x27;pro-motorista-monthly&#x27;:   { isPro:true,  isMotorista:true,  dias:30,  label:&#x27;Pro Motorista Mensal&#x27;    },
  &#x27;pro-motorista-yearly&#x27;:    { isPro:true,  isMotorista:true,  dias:365, label:&#x27;Pro Motorista Anual&#x27;     },

  // ── Pro+ (tudo liberado) ──
  &#x27;proplus-monthly&#x27;:         { isPro:true,  isMotorista:true,  dias:30,  label:&#x27;Pro+ Mensal&#x27;             },
  &#x27;proplus-yearly&#x27;:          { isPro:true,  isMotorista:true,  dias:365, label:&#x27;Pro+ Anual&#x27;              },

  // Retrocompatibilidade com planos antigos
  &#x27;monthly&#x27;: { isPro:true,  isMotorista:false, dias:30,  label:&#x27;Pro Mensal (legado)&#x27; },
  &#x27;yearly&#x27;:  { isPro:true,  isMotorista:false, dias:365, label:&#x27;Pro Anual (legado)&#x27;  },
};

// Busca preço do plano no Firestore (respeita promoções)
async function getPlanPrice(plan, pricing) {
  const promoAtiva = pricing.promoExpires &amp;&amp; new Date(pricing.promoExpires) &gt; new Date();
  const defaults = {
    &#x27;motorista-monthly&#x27;: pricing.motorista        || 9.90,
    &#x27;motorista-yearly&#x27;:  pricing.motoristaYearly  || 89.90,
    &#x27;pro-monthly&#x27;:             promoAtiva &amp;&amp; pricing.promoMonthly ? pricing.promoMonthly : (pricing.monthly       || 19.90),
    &#x27;pro-yearly&#x27;:              promoAtiva &amp;&amp; pricing.promoYearly  ? pricing.promoYearly  : (pricing.yearly        || 189.90),
    &#x27;pro-motorista-monthly&#x27;:   pricing.proMotorista       || 24.90,
    &#x27;pro-motorista-yearly&#x27;:    pricing.proMotoristaYearly || 229.90,
    &#x27;proplus-monthly&#x27;:         pricing.proPlus            || 29.90,
    &#x27;proplus-yearly&#x27;:          pricing.proPlusYearly      || 269.90,
    // legado
    &#x27;monthly&#x27;:           promoAtiva &amp;&amp; pricing.promoMonthly ? pricing.promoMonthly : (pricing.monthly  || 19.90),
    &#x27;yearly&#x27;:            promoAtiva &amp;&amp; pricing.promoYearly  ? pricing.promoYearly  : (pricing.yearly   || 189.90),
  };
  return defaults[plan] || 9.90;
}

// Monta o objeto Firestore para ativar um plano
// Busca pricing sempre fresco do Firestore
async function fetchPricing(db) {
  try {
    const doc = await db.collection(&#x27;settings&#x27;).doc(&#x27;pricing&#x27;).get();
    return doc.exists ? doc.data() : {};
  } catch(e) {
    console.warn(&#x27;fetchPricing error:&#x27;, e.message);
    return {};
  }
}

// Monta o objeto Firestore para ativar um plano
async function buildPlanUpdate(plan, subId, db) {
  const def = PLANOS_DEF[plan];
  if (!def) { console.warn(&#x27;Plano desconhecido:&#x27;, plan); return null; }

  const now     = new Date();
  const expires = new Date(now.getTime() + def.dias * 24 * 60 * 60 * 1000).toISOString();

  // Busca estado atual do usuário para não sobrescrever módulos já ativos
  let current = {};
  if (db &amp;&amp; subId === null) {
    // será chamado com uid quando disponível
  }

  // Nunca revoga um módulo que já está ativo e não expirou
  // Só ativa o que o novo plano define — nunca desativa o que já existe
  const update = {
    proPlan:   plan,
    proSince:  now.toISOString(),
    proCancelled: false,
    ...(subId &amp;&amp; { proSubscriptionId: subId }),
  };

  // isPro: ativa se o novo plano tem, mas nunca revoga
  if (def.isPro) {
    update.isPro         = true;
    update.proExpiresAt  = expires;
  }

  // isMotorista: ativa se o novo plano tem, mas nunca revoga
  if (def.isMotorista) {
    update.isMotorista        = true;
    update.motoristaExpiresAt = expires;
  }

  return update;
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ROTA PÚBLICA — PREÇOS (usada pelo planos.html)
// ─────────────────────────────────────────────
app.get(&#x27;/pricing&#x27;, async (req, res) =&gt; {
  res.header(&#x27;Access-Control-Allow-Origin&#x27;, &#x27;*&#x27;);
  try {
    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const pricing = await fetchPricing(getDb());
    res.json(pricing);
  } catch(e) {
    res.json({});
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — CRIAR ASSINATURA RECORRENTE
// ─────────────────────────────────────────────
app.post(&#x27;/create-payment&#x27;, async (req, res) =&gt; {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if (!plan || !userId) return res.status(400).json({ error: &#x27;Dados inválidos&#x27; });
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: `Plano inválido: ${plan}` });

    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();
    const pricing = await fetchPricing(db);

    const price = await getPlanPrice(plan, pricing);
    const def   = PLANOS_DEF[plan];
    const isYearly   = plan.endsWith(&#x27;-yearly&#x27;) || plan === &#x27;yearly&#x27;;
    const frequency  = isYearly ? 12 : 1;

    const response = await fetch(&#x27;https://api.mercadopago.com/preapproval&#x27;, {
      method: &#x27;POST&#x27;,
      headers: {
        &#x27;Content-Type&#x27;: &#x27;application/json&#x27;,
        &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        reason:             &#x27;Allo Finanças — &#x27; + def.label,
        external_reference: userId + &#x27;|&#x27; + plan,
        payer_email:        userEmail || &#x27;&#x27;,
        auto_recurring: {
          frequency,
          frequency_type:     &#x27;months&#x27;,
          transaction_amount: price,
          currency_id:        &#x27;BRL&#x27;
        },
        back_url:         &#x27;https://allofinancas.com/app?payment=success&#x27;,
        status:           &#x27;pending&#x27;,
        notification_url: &#x27;https://finny-bot.onrender.com/webhook-mp&#x27;
      })
    });

    const data = await response.json();
    console.log(&#x27;MP preapproval response:&#x27;, JSON.stringify(data));
    if (!data.init_point) return res.status(500).json({ error: &#x27;Erro ao criar assinatura&#x27; });
    res.json({ url: data.init_point, plan: def.label, price });
  } catch(e) {
    console.error(&#x27;MP create-payment error:&#x27;, e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — PAGAMENTO ÚNICO (PIX/BOLETO)
// ─────────────────────────────────────────────
app.post(&#x27;/create-payment-pix&#x27;, async (req, res) =&gt; {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if (!plan || !userId) return res.status(400).json({ error: &#x27;Dados inválidos&#x27; });
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: `Plano inválido: ${plan}` });

    const { getDb: getDb2 } = require(&#x27;./config/firebase&#x27;);
    const db2 = getDb2();
    const pricing = await fetchPricing(db2);

    const price = await getPlanPrice(plan, pricing);
    const def   = PLANOS_DEF[plan];

    const response = await fetch(&#x27;https://api.mercadopago.com/checkout/preferences&#x27;, {
      method: &#x27;POST&#x27;,
      headers: {
        &#x27;Content-Type&#x27;: &#x27;application/json&#x27;,
        &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        items: [{ title: &#x27;Allo Finanças — &#x27; + def.label, quantity: 1, currency_id: &#x27;BRL&#x27;, unit_price: price }],
        payer:              { email: userEmail || &#x27;&#x27;, name: userName || &#x27;&#x27; },
        external_reference: userId + &#x27;|&#x27; + plan,
        back_urls: {
          success: &#x27;https://allofinancas.com/app?payment=success&#x27;,
          failure: &#x27;https://allofinancas.com/app?payment=failure&#x27;,
          pending: &#x27;https://allofinancas.com/app?payment=pending&#x27;
        },
        auto_return:            &#x27;approved&#x27;,
        statement_descriptor:   &#x27;Allo Financas&#x27;,
        notification_url:       &#x27;https://finny-bot.onrender.com/webhook-mp&#x27;,
        payment_methods: {
          excluded_payment_types: [
            { id: &#x27;credit_card&#x27; },
            { id: &#x27;debit_card&#x27; }
          ]
        }
      })
    });

    const data = await response.json();
    if (!data.init_point) return res.status(500).json({ error: &#x27;Erro ao criar pagamento&#x27; });
    res.json({ url: data.init_point, plan: def.label, price });
  } catch(e) {
    console.error(&#x27;MP PIX error:&#x27;, e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — CANCELAR ASSINATURA
// ─────────────────────────────────────────────
app.post(&#x27;/cancel-subscription&#x27;, async (req, res) =&gt; {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: &#x27;userId obrigatório&#x27; });

    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();

    const userDoc  = await db.collection(&#x27;users&#x27;).doc(userId).get();
    const userData = userDoc.data() || {};
    const subscriptionId = userData.proSubscriptionId;

    if (!subscriptionId) return res.status(400).json({ error: &#x27;Nenhuma assinatura ativa&#x27; });

    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
      method: &#x27;PUT&#x27;,
      headers: {
        &#x27;Content-Type&#x27;: &#x27;application/json&#x27;,
        &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({ status: &#x27;cancelled&#x27; })
    });

    const mpData = await mpRes.json();
    console.log(&#x27;MP cancel response:&#x27;, JSON.stringify(mpData));

    if (mpData.status !== &#x27;cancelled&#x27;) return res.status(500).json({ error: &#x27;Erro ao cancelar no Mercado Pago&#x27; });

    // Mantém Pro até expirar naturalmente — só marca como cancelado
    await db.collection(&#x27;users&#x27;).doc(userId).set({
      proCancelled:   true,
      proCancelledAt: new Date().toISOString(),
      proSubscriptionStatus: &#x27;cancelled&#x27;,
    }, { merge: true });

    res.json({ success: true });
  } catch(e) {
    console.error(&#x27;Cancel error:&#x27;, e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — WEBHOOK
// ─────────────────────────────────────────────
function verifyMercadoPagoSignature(req) {
  const signature = req.headers[&#x27;x-signature&#x27;];
  const secret    = process.env.MP_WEBHOOK_SECRET;
  if (!signature || !secret) return false;
  const hashPart = (signature.split(&#x27;,&#x27;).find(p =&gt; p.startsWith(&#x27;v1=&#x27;)) || &#x27;&#x27;).replace(&#x27;v1=&#x27;, &#x27;&#x27;);
  const generated = crypto.createHmac(&#x27;sha256&#x27;, secret).update(JSON.stringify(req.body)).digest(&#x27;hex&#x27;);
  return generated === hashPart;
}

app.post(&#x27;/webhook-mp&#x27;, async (req, res) =&gt; {
  // Responde imediatamente para o MP não retentar
  res.sendStatus(200);

  try {
    const { type, data } = req.body;
    if (!type || !data) { console.warn(&#x27;Webhook inválido (sem dados)&#x27;); return; }

    console.log(&#x27;Webhook MP:&#x27;, type, data);

    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();

    // ── PAGAMENTO ÚNICO (PIX/Boleto) ──
    if (type === &#x27;payment&#x27;) {
      const paymentId = data?.id;
      if (!paymentId) return;

      const pmtRes = await fetch(&#x27;https://api.mercadopago.com/v1/payments/&#x27; + paymentId, {
        headers: { &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN }
      });
      const pmt = await pmtRes.json();
      console.log(&#x27;STATUS PAGAMENTO:&#x27;, pmt.status, &#x27;| PLANO:&#x27;, pmt.external_reference);

      if (pmt.status !== &#x27;approved&#x27;) return;

      const [userId, plan] = (pmt.external_reference || &#x27;&#x27;).split(&#x27;|&#x27;);
      if (!userId || !plan) return;

      const update = await buildPlanUpdate(plan, null);
      if (!update) return;

      update.proPaymentId = String(paymentId);
      await db.collection(&#x27;users&#x27;).doc(userId).set(update, { merge: true });
      console.log(&#x27;✅ Plano ativado (pagamento):&#x27;, plan, &#x27;→&#x27;, userId);
    }

    // ── ASSINATURA CRIADA / ATUALIZADA ──
    if (type === &#x27;subscription_preapproval&#x27;) {
      const subId = data?.id;
      if (!subId) return;

      const subRes = await fetch(&#x27;https://api.mercadopago.com/preapproval/&#x27; + subId, {
        headers: { &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN }
      });
      const sub = await subRes.json();

      const [userId, plan] = (sub.external_reference || &#x27;&#x27;).split(&#x27;|&#x27;);
      if (!userId) return;

      // Salva ID e status da assinatura
      await db.collection(&#x27;users&#x27;).doc(userId).set({
        proSubscriptionId:     subId,
        proSubscriptionStatus: sub.status,
      }, { merge: true });

      console.log(&#x27;📋 Assinatura salva:&#x27;, subId, &#x27;| status:&#x27;, sub.status);

      // Cancelamento
      if (sub.status === &#x27;cancelled&#x27;) {
        await db.collection(&#x27;users&#x27;).doc(userId).set({
          // No cancelamento, revoga apenas o módulo do plano cancelado
        ...(PLANOS_DEF[plan]?.isPro        &amp;&amp; { isPro: false,        proExpiresAt: null }),
        ...(PLANOS_DEF[plan]?.isMotorista  &amp;&amp; { isMotorista: false,  motoristaExpiresAt: null }),
        proCancelled:          true,
        proCancelledAt:        new Date().toISOString(),
        proSubscriptionStatus: &#x27;cancelled&#x27;,
        }, { merge: true });
        console.log(&#x27;❌ Plano cancelado:&#x27;, userId);
      }
    }

    // ── COBRANÇA RECORRENTE APROVADA ──
    if (type === &#x27;subscription_authorized_payment&#x27;) {
      const subId = data?.id;
      if (!subId) return;

      const subRes = await fetch(&#x27;https://api.mercadopago.com/preapproval/&#x27; + subId, {
        headers: { &#x27;Authorization&#x27;: &#x27;Bearer &#x27; + process.env.MP_ACCESS_TOKEN }
      });
      const sub = await subRes.json();

      const [userId, plan] = (sub.external_reference || &#x27;&#x27;).split(&#x27;|&#x27;);
      if (!userId || !plan) return;

      const update = await buildPlanUpdate(plan, subId);
      if (!update) return;

      await db.collection(&#x27;users&#x27;).doc(userId).set(update, { merge: true });
      console.log(&#x27;🔥 Renovação via assinatura:&#x27;, plan, &#x27;→&#x27;, userId);
    }

  } catch(e) {
    console.error(&#x27;Webhook MP error:&#x27;, e);
  }
});

// ─────────────────────────────────────────────
// AI ANALYSIS ROUTE
// ─────────────────────────────────────────────
app.post(&#x27;/ai-analysis&#x27;, requireAiUser, aiRateLimiter(&#x27;analysis&#x27;), handleAiAnalysis);

// Indicação processada no servidor para impedir concessão de plano pelo cliente.
app.post(&#x27;/apply-referral&#x27;, async (req, res) =&gt; {
  try {
    const token = String(req.headers.authorization || &#x27;&#x27;).replace(/^Bearer\s+/i, &#x27;&#x27;);
    const code = String(req.body?.code || &#x27;&#x27;).trim().toUpperCase();
    if (!token) return res.status(401).json({ error: &#x27;Autenticação necessária&#x27; });
    if (!/^ALLO-[A-Z0-9-]+$/.test(code)) return res.status(400).json({ error: &#x27;Código inválido&#x27; });

    const { getDb, admin } = require(&#x27;./config/firebase&#x27;);
    const decoded = await admin.auth().verifyIdToken(token);
    const db = getDb();
    const userRef = db.collection(&#x27;users&#x27;).doc(decoded.uid);
    const referralRef = db.collection(&#x27;referrals&#x27;).doc(code);

    const result = await db.runTransaction(async tx =&gt; {
      const [userSnap, referralSnap] = await Promise.all([tx.get(userRef), tx.get(referralRef)]);
      if (!referralSnap.exists) throw Object.assign(new Error(&#x27;Código não encontrado&#x27;), { status: 404 });
      const referrerId = referralSnap.data().userId;
      if (!referrerId || referrerId === decoded.uid) throw Object.assign(new Error(&#x27;Código não permitido&#x27;), { status: 400 });
      const userData = userSnap.data() || {};
      if (userData.referralProcessed) throw Object.assign(new Error(&#x27;Código já utilizado&#x27;), { status: 409 });

      const referrerRef = db.collection(&#x27;users&#x27;).doc(referrerId);
      const referrerSnap = await tx.get(referrerRef);
      if (!referrerSnap.exists) throw Object.assign(new Error(&#x27;Indicador não encontrado&#x27;), { status: 404 });
      const now = new Date();
      const trialExpires = new Date(now.getTime() + 7*86400000).toISOString();
      const referrerData = referrerSnap.data() || {};
      const currentExpiry = new Date(referrerData.proExpiresAt || 0);
      const base = currentExpiry &gt; now ? currentExpiry : now;
      const referrerExpires = new Date(base.getTime() + 30*86400000).toISOString();

      tx.set(userRef, { isPro:true, proPlan:&#x27;trial&#x27;, proSince:now.toISOString(), proExpiresAt:trialExpires, referralProcessed:true, referredBy:referrerId }, { merge:true });
      tx.set(referrerRef, { isPro:true, proPlan:referrerData.proPlan || &#x27;referral&#x27;, proExpiresAt:referrerExpires, referralCount:(referrerData.referralCount || 0)+1 }, { merge:true });
      tx.set(db.collection(&#x27;admin_messages&#x27;).doc(), { target:&#x27;user&#x27;, userId:referrerId, type:&#x27;success&#x27;, title:&#x27;🎉 Sua indicação deu frutos!&#x27;, body:&#x27;Um amigo usou seu código. Você ganhou mais 1 mês de Pro.&#x27;, createdAt:admin.firestore.FieldValue.serverTimestamp(), createdBy:&#x27;sistema&#x27; });
      return { referrerId, trialExpires };
    });
    res.json({ ok:true, ...result });
  } catch (e) {
    logger.warn(&#x27;apply-referral:&#x27;, e.message);
    res.status(e.status || 500).json({ error:e.message || &#x27;Erro ao aplicar indicação&#x27; });
  }
});

// ─────────────────────────────────────────────
// ADMIN API — Firebase Auth e auditoria protegida
// ─────────────────────────────────────────────
async function requireAdminRequest(req, res, next) {
  try {
    const token=String(req.headers.authorization||&#x27;&#x27;).replace(/^Bearer\s+/i,&#x27;&#x27;);
    if(!token) return res.status(401).json({error:&#x27;Autenticação necessária&#x27;});
    const {getDb,admin}=require(&#x27;./config/firebase&#x27;);
    const decoded=await admin.auth().verifyIdToken(token,true);
    const userDoc=await getDb().collection(&#x27;users&#x27;).doc(decoded.uid).get();
    const profile=userDoc.data()||{};
    if(profile.role!==&#x27;admin&#x27;&amp;&amp;decoded.admin!==true) return res.status(403).json({error:&#x27;Acesso administrativo negado&#x27;});
    req.adminIdentity={uid:decoded.uid,email:decoded.email||profile.email||&#x27;&#x27;,profile};
    next();
  } catch(e) {
    logger.warn(&#x27;Admin auth denied:&#x27;,e.message);
    res.status(401).json({error:&#x27;Sessão administrativa inválida ou expirada&#x27;});
  }
}

async function writeAdminAudit(req,action,targetUid,outcome=&#x27;success&#x27;,details={}){
  try{
    const {getDb,admin}=require(&#x27;./config/firebase&#x27;);
    const now=new Date().toISOString();
    await getDb().collection(&#x27;admin_logs&#x27;).add({
      action,targetUid,outcome,details,
      adminUid:req.adminIdentity?.uid||null,
      admin:req.adminIdentity?.email||null,
      msg:`${action} · ${targetUid||&#x27;sistema&#x27;} · ${outcome}`,
      tipo:outcome===&#x27;success&#x27;?&#x27;green&#x27;:&#x27;red&#x27;,
      ts:now,
      createdAt:admin.firestore.FieldValue.serverTimestamp(),
    });
  }catch(e){logger.warn(&#x27;Admin audit write failed:&#x27;,e.message)}
}

function serializeAuthUser(user){
  return {
    uid:user.uid,email:user.email||null,displayName:user.displayName||null,
    phoneNumber:user.phoneNumber||null,photoURL:user.photoURL||null,
    emailVerified:user.emailVerified===true,disabled:user.disabled===true,
    creationTime:user.metadata?.creationTime||null,
    lastSignInTime:user.metadata?.lastSignInTime||null,
    lastRefreshTime:user.metadata?.lastRefreshTime||null,
    providers:(user.providerData||[]).map(p=&gt;p.providerId).filter(Boolean),
    customClaims:user.customClaims||{},
  };
}

app.get(&#x27;/admin/health&#x27;,requireAdminRequest,async(req,res)=&gt;{
  const {admin}=require(&#x27;./config/firebase&#x27;);
  res.json({ok:true,service:&#x27;Allo Admin API&#x27;,projectId:admin.app().options.projectId||null,time:new Date().toISOString()});
});

app.get(&#x27;/admin/users&#x27;,requireAdminRequest,async(req,res)=&gt;{
  try{
    const {admin}=require(&#x27;./config/firebase&#x27;);
    const users=[];let pageToken;
    do{
      const page=await admin.auth().listUsers(1000,pageToken);
      users.push(...page.users.map(serializeAuthUser));
      pageToken=page.pageToken;
    }while(pageToken&amp;&amp;users.length&lt;10000);
    await writeAdminAudit(req,&#x27;users.list&#x27;,null,&#x27;success&#x27;,{count:users.length});
    res.json({ok:true,count:users.length,users});
  }catch(e){await writeAdminAudit(req,&#x27;users.list&#x27;,null,&#x27;error&#x27;,{message:e.message});res.status(500).json({error:&#x27;Não foi possível listar os usuários&#x27;})}
});

app.get(&#x27;/admin/users/:uid&#x27;,requireAdminRequest,async(req,res)=&gt;{
  try{
    const {admin}=require(&#x27;./config/firebase&#x27;);
    const user=await admin.auth().getUser(req.params.uid);
    res.json({ok:true,user:serializeAuthUser(user)});
  }catch(e){res.status(e.code===&#x27;auth/user-not-found&#x27;?404:500).json({error:&#x27;Usuário não encontrado&#x27;})}
});

app.post(&#x27;/admin/users/:uid/action&#x27;,requireAdminRequest,async(req,res)=&gt;{
  const uid=String(req.params.uid||&#x27;&#x27;);
  const action=String(req.body?.action||&#x27;&#x27;);
  const {getDb,admin}=require(&#x27;./config/firebase&#x27;);
  const db=getDb();
  try{
    if(!uid) return res.status(400).json({error:&#x27;UID obrigatório&#x27;});
    const targetDoc=await db.collection(&#x27;users&#x27;).doc(uid).get();
    const target=targetDoc.data()||{};
    const destructive=[&#x27;set-disabled&#x27;,&#x27;delete-account&#x27;];
    if(uid===req.adminIdentity.uid&amp;&amp;destructive.includes(action)) return res.status(400).json({error:&#x27;Esta ação não pode ser executada na própria conta administrativa&#x27;});
    if(target.role===&#x27;admin&#x27;&amp;&amp;destructive.includes(action)) return res.status(403).json({error:&#x27;Contas administrativas exigem um procedimento de segurança separado&#x27;});

    if(action===&#x27;set-disabled&#x27;){
      const disabled=req.body?.disabled===true;
      await admin.auth().updateUser(uid,{disabled});
      await db.collection(&#x27;users&#x27;).doc(uid).set({banned:disabled,updatedAt:new Date().toISOString()},{merge:true});
    }else if(action===&#x27;revoke-sessions&#x27;){
      await admin.auth().revokeRefreshTokens(uid);
    }else if(action===&#x27;set-email-verified&#x27;){
      await admin.auth().updateUser(uid,{emailVerified:req.body?.emailVerified===true});
    }else if(action===&#x27;update-profile&#x27;){
      const update={};
      if(typeof req.body?.displayName===&#x27;string&#x27;&amp;&amp;req.body.displayName.trim()) update.displayName=req.body.displayName.trim().slice(0,100);
      if(typeof req.body?.email===&#x27;string&#x27;&amp;&amp;/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) update.email=req.body.email.trim().toLowerCase();
      if(!Object.keys(update).length) return res.status(400).json({error:&#x27;Nenhum dado válido para atualizar&#x27;});
      const changed=await admin.auth().updateUser(uid,update);
      await db.collection(&#x27;users&#x27;).doc(uid).set({...(update.displayName&amp;&amp;{name:update.displayName}),...(update.email&amp;&amp;{email:update.email}),updatedAt:new Date().toISOString()},{merge:true});
      await writeAdminAudit(req,action,uid,&#x27;success&#x27;,{fields:Object.keys(update)});
      return res.json({ok:true,user:serializeAuthUser(changed)});
    }else if(action===&#x27;delete-account&#x27;){
      await admin.auth().deleteUser(uid);
      if(req.body?.deleteData===true){
        const ref=db.collection(&#x27;users&#x27;).doc(uid);
        if(typeof db.recursiveDelete===&#x27;function&#x27;) await db.recursiveDelete(ref); else await ref.delete();
      }
    }else{
      return res.status(400).json({error:&#x27;Ação administrativa inválida&#x27;});
    }
    await writeAdminAudit(req,action,uid,&#x27;success&#x27;,{disabled:req.body?.disabled,deleteData:req.body?.deleteData});
    res.json({ok:true,action,uid});
  }catch(e){
    logger.error(&#x27;Admin user action failed:&#x27;,e);
    await writeAdminAudit(req,action,uid,&#x27;error&#x27;,{message:e.message});
    const status=e.code===&#x27;auth/user-not-found&#x27;?404:e.code===&#x27;auth/email-already-exists&#x27;?409:500;
    res.status(status).json({error:e.code===&#x27;auth/email-already-exists&#x27;?&#x27;Este e-mail já pertence a outra conta&#x27;:&#x27;A ação administrativa não pôde ser concluída&#x27;});
  }
});
/**
 * Health check
 */
app.get(&#x27;/health&#x27;, handleHealthCheck);
app.post(&#x27;/allofy-chat&#x27;, requireAiUser, aiRateLimiter(&#x27;allofy&#x27;), handleAllofyChat);
app.get(&#x27;/allofy-history&#x27;, requireAiUser, getAllofyHistory);
app.delete(&#x27;/allofy-history&#x27;, requireAiUser, clearAllofyHistory);
app.get(&#x27;/&#x27;, (req, res) =&gt; res.json({ service: &#x27;Allo API&#x27;, status: &#x27;running&#x27; }));

// ═══════════════════════════════════════════════════
// NOTIFICAÇÕES PERSONALIZADAS
// ═══════════════════════════════════════════════════

app.post(&#x27;/notifications/test&#x27;, requireSignedInUser, async (req, res) =&gt; {
  try {
    const profile = req.userData || {};
    if (!profile.pushSubscription || profile.pushEnabled === false) {
      return res.status(409).json({
        error: &#x27;Ative as notificações no aplicativo antes de enviar o teste.&#x27;,
        code: &#x27;push_not_enabled&#x27;,
      });
    }

    const sent = await sendPushToProfile(req.userIdentity.uid, profile, {
      title: &#x27;🔔 Notificações ativadas!&#x27;,
      body: &#x27;Tudo certo. O Allo Finanças já pode enviar seus resumos e alertas personalizados.&#x27;,
      tag: &#x27;notification-test&#x27;,
      url: &#x27;/app?action=open-profile&amp;via=notification&#x27;,
    });

    if (!sent) return res.status(409).json({ error: &#x27;Não foi possível usar a inscrição de notificações deste aparelho.&#x27; });
    res.json({ ok: true });
  } catch (error) {
    logger.warn(`Teste de push falhou: ${error.message}`);
    res.status(500).json({ error: &#x27;Não foi possível enviar a notificação de teste.&#x27; });
  }
});

async function executeNotificationCycle(source = &#x27;internal&#x27;) {
  const result = await runNotificationCycle(new Date());
  logger.info(`🔔 Ciclo de notificações (${source}): ${result.sent} enviada(s), ${result.failures} falha(s), ${result.users} usuário(s).`);
  return result;
}

app.post(&#x27;/notifications/run&#x27;, async (req, res) =&gt; {
  const expected = String(process.env.CRON_SECRET || &#x27;&#x27;).trim();
  const supplied = String(req.get(&#x27;x-cron-secret&#x27;) || &#x27;&#x27;).trim();
  if (!expected) return res.status(503).json({ error: &#x27;CRON_SECRET não configurado.&#x27; });
  const authorized = supplied.length === expected.length &amp;&amp; crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!authorized) return res.status(401).json({ error: &#x27;Acesso não autorizado.&#x27; });

  try {
    res.json({ ok: true, ...(await executeNotificationCycle(&#x27;external&#x27;)) });
  } catch (error) {
    logger.error(`Ciclo externo de notificações falhou: ${error.message}`);
    res.status(500).json({ error: &#x27;Falha ao executar notificações.&#x27; });
  }
});

// Funciona enquanto o serviço está ativo. A rota /notifications/run permite
// que um Cron Job externo acorde o serviço e execute o mesmo ciclo.
cron.schedule(&#x27;*/15 * * * *&#x27;, () =&gt; {
  executeNotificationCycle(&#x27;internal&#x27;).catch(error =&gt; {
    logger.error(`Cron interno de notificações falhou: ${error.message}`);
  });
});

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────

app.use((err, req, res, next) =&gt; {
  logger.error(&#x27;Unhandled error:&#x27;, err);
  res.status(500).json({ error: &#x27;Internal server error&#x27; });
});

app.use((req, res) =&gt; {
  res.status(404).json({ error: &#x27;Route not found&#x27; });
});
// ─────────────────────────────────────────────
// ALLO POINTS — APURAÇÃO MENSAL AUTOMÁTICA
// ─────────────────────────────────────────────
async function apurarRankingMensal(){
  try {
    const now = new Date();
    // Só roda no dia 1 de cada mês
    if(now.getDate() !== 1) return;

    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();

    // Pega o mês anterior
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthKey  = prevMonth.getFullYear() + &#x27;-&#x27; + String(prevMonth.getMonth()+1).padStart(2,&#x27;0&#x27;);
    const monthLabel = prevMonth.toLocaleDateString(&#x27;pt-BR&#x27;, { month: &#x27;long&#x27;, year: &#x27;numeric&#x27; });

    console.log(&#x27;🏆 Apurando ranking de:&#x27;, monthKey);

    // Busca o líder do mês
    const rankSnap = await db.collection(&#x27;ap_ranking&#x27;).doc(monthKey)
      .collection(&#x27;users&#x27;).orderBy(&#x27;points&#x27;, &#x27;desc&#x27;).limit(1).get();

    if(rankSnap.empty){
      console.log(&#x27;Nenhum participante no ranking de&#x27;, monthKey);
      return;
    }

    const winner   = rankSnap.docs[0];
    const winnerId = winner.id;
    const winnerData = winner.data();
    const winnerPts  = winnerData.points || 0;
    const winnerName = winnerData.name || &#x27;Usuário&#x27;;

    console.log(&#x27;🥇 Vencedor:&#x27;, winnerName, &#x27;com&#x27;, winnerPts, &#x27;pts&#x27;);

    // Ativa 1 mês de PRO grátis para o vencedor
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection(&#x27;users&#x27;).doc(winnerId).set({
      isPro: true,
      proPlan: &#x27;monthly&#x27;,
      proSince: now.toISOString(),
      proExpiresAt: expiresAt,
      proCancelled: false,
      proAwardedBy: &#x27;ranking&#x27;,
      proAwardMonth: monthKey
    }, { merge: true });

    // Salva o resultado no Firestore para histórico
    await db.collection(&#x27;ap_ranking&#x27;).doc(monthKey).set({
      winner: { id: winnerId, name: winnerName, points: winnerPts },
      apuratedAt: new Date().toISOString(),
      prize: &#x27;1 mês PRO grátis&#x27;
    }, { merge: true });

    // Envia notificação pelo sistema de mensagens do admin
    await db.collection(&#x27;admin_messages&#x27;).add({
      target: &#x27;all&#x27;,
      type: &#x27;success&#x27;,
      title: &#x27;🏆 Campeão do mês de &#x27; + monthLabel + &#x27;!&#x27;,
      body: winnerName + &#x27; venceu o ranking com &#x27; + winnerPts.toLocaleString(&#x27;pt-BR&#x27;) + &#x27; Allo Points e ganhou 1 mês PRO grátis! Parabéns! 🎉&#x27;,
      createdAt: new Date(),
      createdBy: &#x27;sistema&#x27;
    });

    console.log(&#x27;✅ PRO ativado para o vencedor:&#x27;, winnerName);
  } catch(e){
    console.error(&#x27;apurarRankingMensal error:&#x27;, e);
  }
}

// Roda a apuração todo dia (verifica internamente se é dia 1)
apurarRankingMensal();
setInterval(apurarRankingMensal, 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────
// ALLO POINTS — BÔNUS SALDO POSITIVO MENSAL
// ─────────────────────────────────────────────
async function bonusSaldoPositivo(){
  try {
    const now = new Date();

    // Só roda no último dia do mês
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const isLastDay = tomorrow.getMonth() !== now.getMonth();
    if(!isLastDay) return;

    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();

    // Mês atual no formato YYYY-MM
    const monthKey = now.getFullYear() + &#x27;-&#x27; + String(now.getMonth()+1).padStart(2,&#x27;0&#x27;);

    console.log(&#x27;💰 Verificando saldo positivo do mês:&#x27;, monthKey);

    // Busca todos os usuários
    const usersSnap = await db.collection(&#x27;users&#x27;).get();

    let count = 0;
    for(const userDoc of usersSnap.docs){
      try {
        const userData = userDoc.data();
        const userId   = userDoc.id;

        // Pega transações do mês atual
        const txSnap = await db.collection(&#x27;users&#x27;).doc(userId)
          .collection(&#x27;transactions&#x27;)
          .where(&#x27;date&#x27;, &#x27;&gt;=&#x27;, monthKey + &#x27;-01&#x27;)
          .where(&#x27;date&#x27;, &#x27;&lt;=&#x27;, monthKey + &#x27;-31&#x27;)
          .get().catch(() =&gt; null);

        // Se não tem subcoleção de transações, tenta pelo campo no documento
        let receitas = 0;
        let despesas = 0;

        if(txSnap &amp;&amp; !txSnap.empty){
          txSnap.docs.forEach(d =&gt; {
            const tx = d.data();
            if(tx.type === &#x27;income&#x27;) receitas += tx.amount || 0;
            if(tx.type === &#x27;expense&#x27;) despesas += tx.amount || 0;
          });
        } else {
          // Transações salvas no documento do usuário (estrutura atual do app)
          const transactions = userData.transactions || [];
          transactions.forEach(tx =&gt; {
            if((tx.date || &#x27;&#x27;).startsWith(monthKey)){
              if(tx.type === &#x27;income&#x27;) receitas += tx.amount || 0;
              if(tx.type === &#x27;expense&#x27;) despesas += tx.amount || 0;
            }
          });
        }

        // Verifica se saldo é positivo
        if(receitas &gt; 0 &amp;&amp; receitas &gt; despesas){
          // Verifica se já ganhou bônus este mês
          const jaGanhou = userData[&#x27;apBonus_&#x27; + monthKey];
          if(jaGanhou) continue;

          // Adiciona +200 pts
          const currentPts = userData.alloPoints || 0;
          await db.collection(&#x27;users&#x27;).doc(userId).set({
            alloPoints: currentPts + 200,
            [&#x27;apBonus_&#x27; + monthKey]: true
          }, { merge: true });

          // Histórico
          await db.collection(&#x27;users&#x27;).doc(userId)
            .collection(&#x27;ap_history&#x27;).add({
              type: &#x27;positive_month&#x27;,
              description: &#x27;Mês com saldo positivo! 💰&#x27;,
              points: 200,
              createdAt: new Date()
            });

          // Ranking do mês
          const rankRef = db.collection(&#x27;ap_ranking&#x27;).doc(monthKey)
            .collection(&#x27;users&#x27;).doc(userId);
          const rankDoc = await rankRef.get().catch(() =&gt; null);
          const currentRankPts = rankDoc?.exists ? (rankDoc.data()?.points || 0) : 0;
          await rankRef.set({
            points: currentRankPts + 200,
            name: userData.name || &#x27;Usuário&#x27;,
            updatedAt: new Date()
          }, { merge: true });

          count++;
          console.log(&#x27;✅ +200 pts para:&#x27;, userData.name || userId);
        }
      } catch(e){
        console.warn(&#x27;bonusSaldoPositivo user error:&#x27;, e);
      }
    }

    console.log(&#x27;💰 Bônus saldo positivo aplicado para&#x27;, count, &#x27;usuários&#x27;);
  } catch(e){
    console.error(&#x27;bonusSaldoPositivo error:&#x27;, e);
  }
}

// Roda todo dia (verifica internamente se é último dia do mês)
bonusSaldoPositivo();
setInterval(bonusSaldoPositivo, 24 * 60 * 60 * 1000);
// ─────────────────────────────────────────────
// JOB DIÁRIO — VERIFICA EXPIRAÇÃO DO PRO
// ─────────────────────────────────────────────
async function checkProExpirations(){
  try {
    const { getDb } = require(&#x27;./config/firebase&#x27;);
    const db = getDb();
    const now = new Date();
    const snap = await db.collection(&#x27;users&#x27;).where(&#x27;isPro&#x27;,&#x27;==&#x27;,true).get();

    for(const doc of snap.docs){
      const data = doc.data();
      if(!data.proExpiresAt) continue;

      const expiresAt = new Date(data.proExpiresAt);
      const daysLeft = Math.ceil((expiresAt - now) / (1000*60*60*24));

      // Desativa se expirou
      if(daysLeft &lt;= 0){
        await db.collection(&#x27;users&#x27;).doc(doc.id).set({
          isPro: false,
          proExpired: true,
          proExpiredAt: now.toISOString()
        }, { merge: true });
        console.log(&#x27;❌ PRO expirado para:&#x27;, doc.id);
        continue;
      }

      // Salva dias restantes para o app exibir
      await db.collection(&#x27;users&#x27;).doc(doc.id).set({
        proDaysLeft: daysLeft
      }, { merge: true });

      console.log(&#x27;⏳ PRO:&#x27;, doc.id, &#x27;- dias restantes:&#x27;, daysLeft);
    }
  } catch(e){
    console.error(&#x27;checkProExpirations error:&#x27;, e);
  }
}

// Roda imediatamente e depois a cada 24h
checkProExpirations();
setInterval(checkProExpirations, 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () =&gt; {
  logger.info(`🚀 Allo API running on port ${PORT}`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || &#x27;development&#x27;}`);
  logger.info(&#x27;🔔 Agendador de notificações ativo (a cada 15 minutos).&#x27;);
});

// Graceful shutdown
process.on(&#x27;SIGTERM&#x27;, () =&gt; {
  logger.info(&#x27;SIGTERM received — shutting down gracefully&#x27;);
  process.exit(0);
});

process.on(&#x27;unhandledRejection&#x27;, (reason) =&gt; {
  logger.error(&#x27;Unhandled Rejection:&#x27;, reason);
});

module.exports = app;
</pre>
<script>
async function copyCode(){
  const text = document.getElementById('code').innerText;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('status').textContent='✅ Código completo copiado. Agora cole no src/server.js do GitHub.';
  } catch(e) {
    const r=document.createRange(); r.selectNodeContents(document.getElementById('code'));
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.getElementById('status').textContent='Selecione e copie o texto destacado.';
  }
}
</script>
</body>
</html>