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
require('./config/firebase');
const { handleHealthCheck } = require('./controllers/healthController');
const logger = require('./utils/logger');
const { handleAllofyChat } = require('./controllers/allofyController');

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

app.use(cors());
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

app.post('/import-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const pdfParse = require('pdf-parse');
    const data = await pdfParse(req.file.buffer);
    const text = data.text || '';

    if (!text.trim()) return res.status(400).json({ error: 'PDF sem texto legível' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const ano = new Date().getFullYear();
    const prompt = 'Analise este texto de fatura bancaria brasileira. RETORNE APENAS JSON PURO:\n{"transactions":[{"desc":"descricao","amount":0.00,"type":"expense","date":"' + ano + '-MM-DD"}]}\n\nExtraia todos os itens que tenham: data no formato DD/MM + texto descritivo + valor numerico.\nExemplos do que extrair:\n10/04 PAG BOLETO BANCARIO 146,88 -> income\n28/04 CUSTO TRANS EXTERIOR IOF 6,13 -> expense\n27/04 ANUIDADE DIFERENCIADA 33,00 -> expense\n27/04 CREAO AI LIMITED 70,61 -> expense\n\nSe nao encontrar lancamentos com data+descricao+valor, retorne {"transactions":[{"desc":"Lancamento fatura","amount":253.75,"type":"expense","date":"' + ano + '-04-28"}]}\n\nTexto:\n' + text;
const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ text: message.content?.[0]?.text || '' });
  } catch (e) {
    console.error('PDF import error:', e);
    res.status(500).json({ error: e.message || 'Erro ao processar PDF' });
  }
});

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
async function buildPlanUpdate(plan, subId, db) {
  const def = PLANOS_DEF[plan];
  if (!def) { console.warn('Plano desconhecido:', plan); return null; }

  const now     = new Date();
  const expires = new Date(now.getTime() + def.dias * 24 * 60 * 60 * 1000).toISOString();

  // Busca estado atual do usuário para não sobrescrever módulos já ativos
  let current = {};
  if (db && subId === null) {
    // será chamado com uid quando disponível
  }

  // Nunca revoga um módulo que já está ativo e não expirou
  // Só ativa o que o novo plano define — nunca desativa o que já existe
  const update = {
    proPlan:   plan,
    proSince:  now.toISOString(),
    proCancelled: false,
    ...(subId && { proSubscriptionId: subId }),
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
// MERCADO PAGO — CRIAR ASSINATURA RECORRENTE
// ─────────────────────────────────────────────
app.post('/create-payment', async (req, res) => {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if (!plan || !userId) return res.status(400).json({ error: 'Dados inválidos' });
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: `Plano inválido: ${plan}` });

    const { getDb } = require('./config/firebase');
    const db = getDb();
    const pricing = await fetchPricing(db);

    const price = await getPlanPrice(plan, pricing);
    const def   = PLANOS_DEF[plan];
    const isYearly   = plan.endsWith('-yearly') || plan === 'yearly';
    const frequency  = isYearly ? 12 : 1;

    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        reason:             'Allo Finanças — ' + def.label,
        external_reference: userId + '|' + plan,
        payer_email:        userEmail || '',
        auto_recurring: {
          frequency,
          frequency_type:     'months',
          transaction_amount: price,
          currency_id:        'BRL'
        },
        back_url:         'https://allofinancas.com/app?payment=success',
        status:           'pending',
        notification_url: 'https://finny-bot.onrender.com/webhook-mp'
      })
    });

    const data = await response.json();
    console.log('MP preapproval response:', JSON.stringify(data));
    if (!data.init_point) return res.status(500).json({ error: 'Erro ao criar assinatura' });
    res.json({ url: data.init_point, plan: def.label, price });
  } catch(e) {
    console.error('MP create-payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — PAGAMENTO ÚNICO (PIX/BOLETO)
// ─────────────────────────────────────────────
app.post('/create-payment-pix', async (req, res) => {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if (!plan || !userId) return res.status(400).json({ error: 'Dados inválidos' });
    if (!PLANOS_DEF[plan]) return res.status(400).json({ error: `Plano inválido: ${plan}` });

    const { getDb: getDb2 } = require('./config/firebase');
    const db2 = getDb2();
    const pricing = await fetchPricing(db2);

    const price = await getPlanPrice(plan, pricing);
    const def   = PLANOS_DEF[plan];

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        items: [{ title: 'Allo Finanças — ' + def.label, quantity: 1, currency_id: 'BRL', unit_price: price }],
        payer:              { email: userEmail || '', name: userName || '' },
        external_reference: userId + '|' + plan,
        back_urls: {
          success: 'https://allofinancas.com/app?payment=success',
          failure: 'https://allofinancas.com/app?payment=failure',
          pending: 'https://allofinancas.com/app?payment=pending'
        },
        auto_return:            'approved',
        statement_descriptor:   'Allo Financas',
        notification_url:       'https://finny-bot.onrender.com/webhook-mp',
        payment_methods: {
          excluded_payment_types: [
            { id: 'credit_card' },
            { id: 'debit_card' }
          ]
        }
      })
    });

    const data = await response.json();
    if (!data.init_point) return res.status(500).json({ error: 'Erro ao criar pagamento' });
    res.json({ url: data.init_point, plan: def.label, price });
  } catch(e) {
    console.error('MP PIX error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — CANCELAR ASSINATURA
// ─────────────────────────────────────────────
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

    const { getDb } = require('./config/firebase');
    const db = getDb();

    const userDoc  = await db.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    const subscriptionId = userData.proSubscriptionId;

    if (!subscriptionId) return res.status(400).json({ error: 'Nenhuma assinatura ativa' });

    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({ status: 'cancelled' })
    });

    const mpData = await mpRes.json();
    console.log('MP cancel response:', JSON.stringify(mpData));

    if (mpData.status !== 'cancelled') return res.status(500).json({ error: 'Erro ao cancelar no Mercado Pago' });

    // Mantém Pro até expirar naturalmente — só marca como cancelado
    await db.collection('users').doc(userId).set({
      proCancelled:   true,
      proCancelledAt: new Date().toISOString(),
      proSubscriptionStatus: 'cancelled',
    }, { merge: true });

    res.json({ success: true });
  } catch(e) {
    console.error('Cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — WEBHOOK
// ─────────────────────────────────────────────
function verifyMercadoPagoSignature(req) {
  const signature = req.headers['x-signature'];
  const secret    = process.env.MP_WEBHOOK_SECRET;
  if (!signature || !secret) return false;
  const hashPart = (signature.split(',').find(p => p.startsWith('v1=')) || '').replace('v1=', '');
  const generated = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
  return generated === hashPart;
}

app.post('/webhook-mp', async (req, res) => {
  // Responde imediatamente para o MP não retentar
  res.sendStatus(200);

  try {
    const { type, data } = req.body;
    if (!type || !data) { console.warn('Webhook inválido (sem dados)'); return; }

    console.log('Webhook MP:', type, data);

    const { getDb } = require('./config/firebase');
    const db = getDb();

    // ── PAGAMENTO ÚNICO (PIX/Boleto) ──
    if (type === 'payment') {
      const paymentId = data?.id;
      if (!paymentId) return;

      const pmtRes = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
        headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
      });
      const pmt = await pmtRes.json();
      console.log('STATUS PAGAMENTO:', pmt.status, '| PLANO:', pmt.external_reference);

      if (pmt.status !== 'approved') return;

      const [userId, plan] = (pmt.external_reference || '').split('|');
      if (!userId || !plan) return;

      const update = await buildPlanUpdate(plan, null);
      if (!update) return;

      update.proPaymentId = String(paymentId);
      await db.collection('users').doc(userId).set(update, { merge: true });
      console.log('✅ Plano ativado (pagamento):', plan, '→', userId);
    }

    // ── ASSINATURA CRIADA / ATUALIZADA ──
    if (type === 'subscription_preapproval') {
      const subId = data?.id;
      if (!subId) return;

      const subRes = await fetch('https://api.mercadopago.com/preapproval/' + subId, {
        headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
      });
      const sub = await subRes.json();

      const [userId, plan] = (sub.external_reference || '').split('|');
      if (!userId) return;

      // Salva ID e status da assinatura
      await db.collection('users').doc(userId).set({
        proSubscriptionId:     subId,
        proSubscriptionStatus: sub.status,
      }, { merge: true });

      console.log('📋 Assinatura salva:', subId, '| status:', sub.status);

      // Cancelamento
      if (sub.status === 'cancelled') {
        await db.collection('users').doc(userId).set({
          // No cancelamento, revoga apenas o módulo do plano cancelado
        ...(PLANOS_DEF[plan]?.isPro        && { isPro: false,        proExpiresAt: null }),
        ...(PLANOS_DEF[plan]?.isMotorista  && { isMotorista: false,  motoristaExpiresAt: null }),
        proCancelled:          true,
        proCancelledAt:        new Date().toISOString(),
        proSubscriptionStatus: 'cancelled',
        }, { merge: true });
        console.log('❌ Plano cancelado:', userId);
      }
    }

    // ── COBRANÇA RECORRENTE APROVADA ──
    if (type === 'subscription_authorized_payment') {
      const subId = data?.id;
      if (!subId) return;

      const subRes = await fetch('https://api.mercadopago.com/preapproval/' + subId, {
        headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
      });
      const sub = await subRes.json();

      const [userId, plan] = (sub.external_reference || '').split('|');
      if (!userId || !plan) return;

      const update = await buildPlanUpdate(plan, subId);
      if (!update) return;

      await db.collection('users').doc(userId).set(update, { merge: true });
      console.log('🔥 Renovação via assinatura:', plan, '→', userId);
    }

  } catch(e) {
    console.error('Webhook MP error:', e);
  }
});

// ─────────────────────────────────────────────
// AI ANALYSIS ROUTE
// ─────────────────────────────────────────────
app.post('/ai-analysis', async (req, res) => {
  try {
    const { prompt, image, imageType } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt obrigatório' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let content;
    if (image) {
      content = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageType || 'image/jpeg',
            data: image
          }
        },
        { type: 'text', text: prompt }
      ];
    } else {
      content = prompt;
    }

    const message = await client.messages.create({
  model: image ? 'claude-haiku-4-5-20251001' : 'claude-haiku-4-5-20251001',
  max_tokens: 2000,
  messages: [{ role: 'user', content }]
});

    res.json({ text: message.content?.[0]?.text || '' });
  } catch (e) {
    console.error('AI error:', e);
    res.status(500).json({ error: e.message || 'Erro ao consultar IA' });
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
/**
 * Health check
 */
app.get('/health', handleHealthCheck);
app.post('/allofy-chat', handleAllofyChat);
app.get('/', (req, res) => res.json({ service: 'Allo API', status: 'running' }));

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
// ALLO POINTS — APURAÇÃO MENSAL AUTOMÁTICA
// ─────────────────────────────────────────────
async function apurarRankingMensal(){
  try {
    const now = new Date();
    // Só roda no dia 1 de cada mês
    if(now.getDate() !== 1) return;

    const { getDb } = require('./config/firebase');
    const db = getDb();

    // Pega o mês anterior
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthKey  = prevMonth.getFullYear() + '-' + String(prevMonth.getMonth()+1).padStart(2,'0');
    const monthLabel = prevMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    console.log('🏆 Apurando ranking de:', monthKey);

    // Busca o líder do mês
    const rankSnap = await db.collection('ap_ranking').doc(monthKey)
      .collection('users').orderBy('points', 'desc').limit(1).get();

    if(rankSnap.empty){
      console.log('Nenhum participante no ranking de', monthKey);
      return;
    }

    const winner   = rankSnap.docs[0];
    const winnerId = winner.id;
    const winnerData = winner.data();
    const winnerPts  = winnerData.points || 0;
    const winnerName = winnerData.name || 'Usuário';

    console.log('🥇 Vencedor:', winnerName, 'com', winnerPts, 'pts');

    // Ativa 1 mês de PRO grátis para o vencedor
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('users').doc(winnerId).set({
      isPro: true,
      proPlan: 'monthly',
      proSince: now.toISOString(),
      proExpiresAt: expiresAt,
      proCancelled: false,
      proAwardedBy: 'ranking',
      proAwardMonth: monthKey
    }, { merge: true });

    // Salva o resultado no Firestore para histórico
    await db.collection('ap_ranking').doc(monthKey).set({
      winner: { id: winnerId, name: winnerName, points: winnerPts },
      apuratedAt: new Date().toISOString(),
      prize: '1 mês PRO grátis'
    }, { merge: true });

    // Envia notificação pelo sistema de mensagens do admin
    await db.collection('admin_messages').add({
      target: 'all',
      type: 'success',
      title: '🏆 Campeão do mês de ' + monthLabel + '!',
      body: winnerName + ' venceu o ranking com ' + winnerPts.toLocaleString('pt-BR') + ' Allo Points e ganhou 1 mês PRO grátis! Parabéns! 🎉',
      createdAt: new Date(),
      createdBy: 'sistema'
    });

    console.log('✅ PRO ativado para o vencedor:', winnerName);
  } catch(e){
    console.error('apurarRankingMensal error:', e);
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

    const { getDb } = require('./config/firebase');
    const db = getDb();

    // Mês atual no formato YYYY-MM
    const monthKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

    console.log('💰 Verificando saldo positivo do mês:', monthKey);

    // Busca todos os usuários
    const usersSnap = await db.collection('users').get();

    let count = 0;
    for(const userDoc of usersSnap.docs){
      try {
        const userData = userDoc.data();
        const userId   = userDoc.id;

        // Pega transações do mês atual
        const txSnap = await db.collection('users').doc(userId)
          .collection('transactions')
          .where('date', '>=', monthKey + '-01')
          .where('date', '<=', monthKey + '-31')
          .get().catch(() => null);

        // Se não tem subcoleção de transações, tenta pelo campo no documento
        let receitas = 0;
        let despesas = 0;

        if(txSnap && !txSnap.empty){
          txSnap.docs.forEach(d => {
            const tx = d.data();
            if(tx.type === 'income') receitas += tx.amount || 0;
            if(tx.type === 'expense') despesas += tx.amount || 0;
          });
        } else {
          // Transações salvas no documento do usuário (estrutura atual do app)
          const transactions = userData.transactions || [];
          transactions.forEach(tx => {
            if((tx.date || '').startsWith(monthKey)){
              if(tx.type === 'income') receitas += tx.amount || 0;
              if(tx.type === 'expense') despesas += tx.amount || 0;
            }
          });
        }

        // Verifica se saldo é positivo
        if(receitas > 0 && receitas > despesas){
          // Verifica se já ganhou bônus este mês
          const jaGanhou = userData['apBonus_' + monthKey];
          if(jaGanhou) continue;

          // Adiciona +200 pts
          const currentPts = userData.alloPoints || 0;
          await db.collection('users').doc(userId).set({
            alloPoints: currentPts + 200,
            ['apBonus_' + monthKey]: true
          }, { merge: true });

          // Histórico
          await db.collection('users').doc(userId)
            .collection('ap_history').add({
              type: 'positive_month',
              description: 'Mês com saldo positivo! 💰',
              points: 200,
              createdAt: new Date()
            });

          // Ranking do mês
          const rankRef = db.collection('ap_ranking').doc(monthKey)
            .collection('users').doc(userId);
          const rankDoc = await rankRef.get().catch(() => null);
          const currentRankPts = rankDoc?.exists ? (rankDoc.data()?.points || 0) : 0;
          await rankRef.set({
            points: currentRankPts + 200,
            name: userData.name || 'Usuário',
            updatedAt: new Date()
          }, { merge: true });

          count++;
          console.log('✅ +200 pts para:', userData.name || userId);
        }
      } catch(e){
        console.warn('bonusSaldoPositivo user error:', e);
      }
    }

    console.log('💰 Bônus saldo positivo aplicado para', count, 'usuários');
  } catch(e){
    console.error('bonusSaldoPositivo error:', e);
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
});

// ═══════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════

async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const { getDb } = require('./config/firebase');
    const db = getDb();
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    const userData = userDoc.data();
    if (!userData.pushSubscription || !userData.pushEnabled) return;

    const subscription = JSON.parse(userData.pushSubscription);
    await webpush.sendNotification(subscription, JSON.stringify({
      title, body,
      icon:  '/favicon.png',
      badge: '/favicon.png',
      tag:   data.tag || 'allofinancas',
      data
    }));
    console.log(`✅ Push enviado → ${userId}: ${title}`);
  } catch(e) {
    if (e.statusCode === 410) {
      const { getDb } = require('./config/firebase');
      const db = getDb();
      await db.collection('users').doc(userId).set(
        { pushSubscription: null, pushEnabled: false }, { merge: true }
      );
    }
    console.warn(`Push error → ${userId}:`, e.message);
  }
}

// ── Cron: todo dia às 08:00 horário de Brasília ──
cron.schedule('0 11 * * *', async () => {
  console.log('🔔 Cron push iniciado...');
  try {
    const { getDb } = require('./config/firebase');
    const db = getDb();

    const usersSnap = await db.collection('users').where('pushEnabled', '==', true).get();

    const hoje     = new Date();
    const hojeISO  = hoje.toISOString().split('T')[0];
    const daqui3   = new Date(); daqui3.setDate(hoje.getDate() + 3);
    const daqui3ISO = daqui3.toISOString().split('T')[0];
    const ym       = hojeISO.slice(0, 7);
    let enviados   = 0;

    for (const doc of usersSnap.docs) {
      const user   = doc.data();
      const userId = doc.id;
      const transactions = user.transactions || [];
      const cards  = user.cards || [];

      // 1. Contas fixas vencendo em até 3 dias
      const contasVencendo = transactions.filter(t =>
        t.recurrence === 'fixed' &&
        t.type === 'expense' &&
        (t.status || 'paid') === 'pending' &&
        t.date >= hojeISO &&
        t.date <= daqui3ISO
      );
      for (const conta of contasVencendo) {
        await sendPushToUser(userId,
          '⚠️ Conta vencendo em breve!',
          `${conta.description || 'Conta'} — R$ ${(conta.amount||0).toFixed(2).replace('.',',')} vence em ${conta.date}`,
          { tag: 'bill-due-'+conta.id, url: '/app' }
        );
        enviados++;
      }

      // 2. Faturas de cartão vencendo em até 7 dias
      for (const card of cards) {
        if (!card.due || !(card.currentInvoice > 0)) continue;
        const dueDay  = parseInt(card.due);
        const dueDate = new Date(hoje.getFullYear(), hoje.getMonth(), dueDay);
        if (dueDate < hoje) dueDate.setMonth(dueDate.getMonth() + 1);
        const diff = Math.ceil((dueDate - hoje) / (1000*60*60*24));
        if (diff <= 7 && diff >= 0) {
          const total = (card.currentInvoice||0) + (card.debtBalance||0);
          await sendPushToUser(userId,
            `💳 Fatura ${card.name} vence em ${diff === 0 ? 'hoje' : diff + ' dia(s)'}!`,
            `Total: R$ ${total.toFixed(2).replace('.',',')}`,
            { tag: 'card-due-'+card.id, url: '/app' }
          );
          enviados++;
        }
      }

      // 3. Resumo semanal — toda segunda-feira
      if (hoje.getDay() === 1) {
        const txMes   = transactions.filter(t => (t.date||'').startsWith(ym));
        const rec     = txMes.filter(t => t.type === 'income').reduce((s,t)=>s+t.amount, 0);
        const desp    = txMes.filter(t => t.type === 'expense').reduce((s,t)=>s+t.amount, 0);
        if (rec > 0 || desp > 0) {
          await sendPushToUser(userId,
            '📊 Resumo semanal',
            `Receitas: R$${rec.toFixed(2).replace('.',',')} · Despesas: R$${desp.toFixed(2).replace('.',',')} · Saldo: R$${(rec-desp).toFixed(2).replace('.',',')}`,
            { tag: 'weekly-summary', url: '/app' }
          );
          enviados++;
        }
      }
    }
    console.log(`✅ Cron push finalizado — ${enviados} notificações enviadas.`);
  } catch(e) {
    console.error('Cron push error:', e);
  }
}, { timezone: 'America/Sao_Paulo' });

module.exports = app;
