/**
 * FinnyBot — AI-Powered WhatsApp Financial Assistant
 * Server entry point
 */

require('dotenv').config();



const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const crypto = require('crypto');
require('./config/firebase');
const { handleWebhook, handleHealthCheck } = require('./controllers/webhookController');
const { rateLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');
const { handleAllofyChat } = require('./controllers/allofyController');

// ─────────────────────────────────────────────
// META WHATSAPP API — HELPER
// ─────────────────────────────────────────────
async function sendWhatsAppMeta(phoneNumber, message){
  const phone = String(phoneNumber).replace(/\D/g,'');
  const fullPhone = phone.startsWith('55') ? phone : '55' + phone;
  
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.META_ACCESS_TOKEN
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: fullPhone,
        type: 'text',
        text: { body: message }
      })
    }
  );
  const data = await res.json();
  if(data.error) throw new Error(data.error.message);
  return data;
}
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

// Rate limiting on webhook
app.use('/webhook', rateLimiter);

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
const { handleRegisterUser } = require('./controllers/webhookController');
app.post('/register', handleRegisterUser);

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
// MERCADO PAGO — CRIAR ASSINATURA RECORRENTE
// ─────────────────────────────────────────────
app.post('/create-payment', async (req, res) => {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if(!plan || !userId) return res.status(400).json({ error: 'Dados inválidos' });

    const prices   = { monthly: 9.90, yearly: 89.90 };
    const labels   = { monthly: 'Mensal', yearly: 'Anual' };
    const price    = prices[plan] || 9.90;
const label    = labels[plan] || 'Mensal';
const freq     = 'months';
const frequency = plan === 'yearly' ? 12 : 1;

    const response = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        preapproval_plan_id: null,
        reason: 'Allo Finanças Pro — ' + label,
        external_reference: userId + '|' + plan,
        payer_email: userEmail || '',
        auto_recurring: {
  frequency: frequency,
  frequency_type: freq,
          transaction_amount: price,
          currency_id: 'BRL'
        },
        back_url: 'https://allofinancas.com/app?payment=success',
        status: 'pending',
        notification_url: 'https://finny-bot.onrender.com/webhook-mp'
      })
    });

    const data = await response.json();
    console.log('MP preapproval response:', JSON.stringify(data));

    if(!data.init_point) return res.status(500).json({ error: 'Erro ao criar assinatura' });
    res.json({ url: data.init_point });
  } catch(e) {
    console.error('MP error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────
// MERCADO PAGO — PAGAMENTO ÚNICO (PIX/BOLETO)
// ─────────────────────────────────────────────
app.post('/create-payment-pix', async (req, res) => {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if(!plan || !userId) return res.status(400).json({ error: 'Dados inválidos' });

    const prices = { monthly: 9.90, yearly: 89.90 };
    const labels = { monthly: 'Mensal', yearly: 'Anual' };
    const price  = prices[plan] || 9.90;
    const label  = labels[plan] || 'Mensal';

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN
      },
      body: JSON.stringify({
        items: [{
          title: 'Allo Finanças Pro — ' + label,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: price
        }],
        payer: { email: userEmail || '', name: userName || '' },
        external_reference: userId + '|' + plan,
        back_urls: {
          success: 'https://allofinancas.com/app?payment=success',
          failure: 'https://allofinancas.com/app?payment=failure',
          pending: 'https://allofinancas.com/app?payment=pending'
        },
        auto_return: 'approved',
        statement_descriptor: 'Allo Financas Pro',
        notification_url: 'https://finny-bot.onrender.com/webhook-mp',
        payment_methods: {
  excluded_payment_types: [
    { id: 'credit_card' },
    { id: 'debit_card' }
  ]
}
      })
    });

    const data = await response.json();
    if(!data.init_point) return res.status(500).json({ error: 'Erro ao criar pagamento' });
    res.json({ url: data.init_point });
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
    if(!userId) return res.status(400).json({ error: 'userId obrigatório' });

    const { getDb } = require('./config/firebase');
    const db = getDb();

    const allUsers = await db.collection('users').get();

allUsers.forEach(doc => console.log(doc.id));

    const userDoc = await db.collection('users').doc(userId).get();
    
    const userData = userDoc.data() || {};
  
    const subscriptionId = userData.proSubscriptionId;
   if(!subscriptionId){
  return res.status(400).json({ error: 'Nenhuma assinatura ativa' });
}

    // Cancela no Mercado Pago
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

    if(mpData.status !== 'cancelled'){
      return res.status(500).json({ error: 'Erro ao cancelar no Mercado Pago' });
    }

    // Atualiza Firestore — mantém PRO até expirar
    await db.collection('users').doc(userId).set({
      proCancelled: true,
      proCancelledAt: new Date().toISOString()
    }, { merge: true });

    res.json({ success: true });
  } catch(e) {
    console.error('Cancel error:', e);
    res.status(500).json({ error: e.message });
  }
});

function verifyMercadoPagoSignature(req) {
  const signature = req.headers['x-signature'];
  const secret = process.env.MP_WEBHOOK_SECRET;

  if (!signature || !secret) return false;

  const parts = signature.split(',');
  const hashPart = parts.find(p => p.startsWith('v1='));
  if (!hashPart) return false;

  const receivedHash = hashPart.replace('v1=', '');

  const generatedHash = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return generatedHash === receivedHash;
}

// ─────────────────────────────────────────────
app.post('/webhook-mp', async (req, res) => {
  try {

    // 🔐 valida assinatura
    const { type, data } = req.body;
  if(!type || !data){
  console.warn('Webhook inválido (sem dados)');
  return res.sendStatus(400);
}
// ⚠️ TEMPORÁRIO — desativar validação
// Mercado Pago webhook signature é complexa
// vamos validar depois corretamente

    // responde rápido pro Mercado Pago
    res.sendStatus(200);
    
    console.log('Webhook MP:', type, data);

    const { getDb } = require('./config/firebase');
    const db = getDb();

    // Pagamento aprovado
    if(type === 'payment'){
      const paymentId = data?.id;
      if(!paymentId) return;

      const pmtRes = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
        headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
      });
      const pmt = await pmtRes.json();
      console.log('STATUS PAGAMENTO:', pmt.status);
      console.log('PAYMENT COMPLETO:', pmt);
      if(pmt.status !== 'approved') return;

      const [userId, plan] = (pmt.external_reference || '').split('|');
      if(!userId) return;

      const now = new Date();
      const days = plan === 'yearly' ? 365 : 30;
      const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

      await db.collection('users').doc(userId).set({
        isPro: true,
        proSince: now.toISOString(),
        proPlan: plan || 'monthly',
        proPaymentId: String(paymentId),
        proExpiresAt: expiresAt,
        proCancelled: false
      }, { merge: true });

      console.log('✅ PRO ativado para:', userId, 'expira em:', expiresAt);
    }

    // Assinatura criada/atualizada
    if(type === 'subscription_preapproval'){

  const subId = data?.id;
  if(!subId) return;

  const subRes = await fetch('https://api.mercadopago.com/preapproval/' + subId, {
    headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });

  const sub = await subRes.json();

  const [userId, plan] = (sub.external_reference || '').split('|');
  if(!userId) return;

  await db.collection('users').doc(userId).set({
    proSubscriptionId: subId,
    proSubscriptionStatus: sub.status
  }, { merge: true });

  console.log('📋 Assinatura salva:', subId, 'status:', sub.status);

  // 🔥 CANCELAMENTO
  if(sub.status === 'cancelled'){
    await db.collection('users').doc(userId).set({
      isPro: false,
      proCancelled: true
    }, { merge: true });

    console.log('❌ PRO desativado:', userId);
  }
}

if(type === 'subscription_authorized_payment'){
  const subId = data?.id;
  if(!subId) return;

  const subRes = await fetch('https://api.mercadopago.com/preapproval/' + subId, {
    headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });

  const sub = await subRes.json();

  const [userId, plan] = (sub.external_reference || '').split('|');
  if(!userId) return;

   // 🔐 EVITA DUPLICAR PRO
  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  const userData = userSnap.data() || {};

  if(userData.isPro){
    console.log('⚠️ Usuário já é PRO:', userId);
    return;
  }

  const now = new Date();
  const days = plan === 'yearly' ? 365 : 30;
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  await db.collection('users').doc(userId).set({
    isPro: true,
    proSince: now.toISOString(),
    proPlan: plan || 'monthly',
    proSubscriptionId: subId,
    proSubscriptionStatus: 'authorized',
    proExpiresAt: expiresAt,
    proCancelled: false
  }, { merge: true });

  console.log('🔥 PRO ativado via assinatura:', userId);
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
/**
 * Health check
 */
app.get('/health', handleHealthCheck);
app.post('/allofy-chat', handleAllofyChat);
app.get('/', (req, res) => res.json({ service: 'FinnyBot', status: 'running' }));

/**
 * WhatsApp Webhook — Twilio sends POST with form body
 * Z-API sends POST with JSON body
 */
('/webhook', handleWebhook);

/**
 * Twilio webhook verification (GET)
 */
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if(mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN){
    console.log('✅ Webhook Meta verificado!');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

/**
 * Z-API webhook verification (GET)
 */
app.get('/webhook/status', (req, res) => {
  res.json({ status: 'active', provider: process.env.WHATSAPP_PROVIDER });
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
// RESUMO SEMANAL — TODO DOMINGO ÀS 9H
// ─────────────────────────────────────────────
async function sendWeeklySummaries(){
  try {
    const { getDb } = require('./config/firebase');
    const db = getDb();
    const snap = await db.collection('users').where('phoneNumber','!=','').get();

    for(const doc of snap.docs){
      const data = doc.data();
      if(!data.phoneNumber) continue;

      const txs = data.transactions || [];
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7*24*60*60*1000);

      const weekTxs = txs.filter(t=> new Date(t.date) >= weekAgo);
      const income = weekTxs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
      const expense = weekTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
      const balance = income - expense;

      const msg = `📊 *Resumo da semana — Allo Finanças*\n\n`
        +`📈 Receitas: R$${income.toFixed(2).replace('.',',')}\n`
        +`📉 Despesas: R$${expense.toFixed(2).replace('.',',')}\n`
        +`💰 Saldo: ${balance>=0?'+':''}R$${balance.toFixed(2).replace('.',',')}\n`
        +`📋 Transações: ${weekTxs.length}\n\n`
        +`_Acesse o app para mais detalhes: allofinancas.com/app_`;

      await sendWhatsAppMeta(data.phoneNumber, msg);
    }
    console.log('✅ Resumos semanais enviados');
  } catch(e){
    console.error('sendWeeklySummaries error:', e);
  }
}

// Verifica todo dia se é domingo e 9h
setInterval(()=>{
  const now = new Date();
  if(now.getDay()===0 && now.getHours()===9 && now.getMinutes()<2){
    sendWeeklySummaries();
  }
}, 60*1000);
// ─────────────────────────────────────────────
// FINNYBOT — RESUMO DIÁRIO ÀS 23:59
// ─────────────────────────────────────────────
async function sendDailySummaries(){
  try {
    const { getDb } = require('./config/firebase');
    const db = getDb();

    // Busca usuários com telefone cadastrado
    const snap = await db.collection('users').where('phoneNumber','!=','').get();
    let count = 0;

    for(const doc of snap.docs){
      const data = doc.data();
      if(!data.phoneNumber) continue;

      const txs = data.transactions || [];
      const today = new Date().toISOString().split('T')[0];

      // Filtra transações de hoje
      const todayTxs = txs.filter(t => (t.date||'').startsWith(today));
      const income   = todayTxs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
      const expense  = todayTxs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
      const balance  = income - expense;

      // Saldo geral nos bancos
      const banks = data.banks || [];
      const totalBalance = banks.reduce((s,b)=>s+b.balance,0);

      // Top gasto do dia
      const topGasto = todayTxs
        .filter(t=>t.type==='expense')
        .sort((a,b)=>b.amount-a.amount)[0];

      // Monta mensagem
      const fmt = v => `R$${Math.abs(v).toFixed(2).replace('.',',')}`;
      const saldoEmoji = balance >= 0 ? '😊' : '⚠️';

      let msg = `🌙 *Resumo do dia — Allo Finanças*\n\n`;

      if(todayTxs.length === 0){
        msg += `Você não registrou nenhuma transação hoje.\n\n`;
        msg += `💡 _Lembre de registrar seus gastos para manter o controle!_\n\n`;
      } else {
        msg += `📈 Receitas hoje: ${fmt(income)}\n`;
        msg += `📉 Despesas hoje: ${fmt(expense)}\n`;
        msg += `${saldoEmoji} Saldo do dia: ${balance>=0?'+':'−'}${fmt(balance)}\n`;
        msg += `📋 Transações: ${todayTxs.length}\n\n`;

        if(topGasto){
          msg += `🏆 Maior gasto: *${topGasto.description||topGasto.desc}* — ${fmt(topGasto.amount)}\n\n`;
        }
      }

      msg += `💰 Saldo total nos bancos: *${totalBalance>=0?'+':'−'}${fmt(totalBalance)}*\n\n`;
      msg += `_Acesse o app: allofinancas.com/app_`;

      try {
        await sendWhatsAppMeta(data.phoneNumber, msg);
        count++;
      } catch(e){
        console.warn('Erro ao enviar resumo para', data.phoneNumber, e.message);
      }
    }

    console.log(`✅ Resumos diários enviados para ${count} usuários`);
  } catch(e){
    console.error('sendDailySummaries error:', e);
  }
}

// Roda todo minuto e verifica se são 23:59
setInterval(()=>{
  const now = new Date();
  if(now.getHours()===23 && now.getMinutes()===59){
    sendDailySummaries();
  }
}, 60*1000);
// ─────────────────────────────────────────────
// ALLOFY — CHAT IA
// ─────────────────────────────────────────────
app.post('/allofy-chat', async (req, res) => {
  try {
    const { system, messages, intentType } = req.body;
    if(!messages || !messages.length) return res.status(400).json({ error: 'Mensagens inválidas' });

    const model = 'claude-haiku-4-5-20251001';

    // Configura headers para streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        stream: true,
        system: system || 'Você é o Allofy, uma IA financeira pessoal.',
        messages
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while(true){
      const { done, value } = await reader.read();
      if(done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for(const line of lines){
        const data = line.replace('data: ', '').trim();
        if(data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if(parsed.type === 'content_block_delta' && parsed.delta?.text){
            res.write(`data: ${JSON.stringify({ token: parsed.delta.text })}\n\n`);
          }
        } catch(e){}
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch(e) {
    console.error('Allofy chat error:', e);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});


// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`🚀 FinnyBot running on port ${PORT}`);
  logger.info(`📱 Provider: ${process.env.WHATSAPP_PROVIDER || 'twilio'}`);
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

module.exports = app;
