/**
 * FinnyBot — AI-Powered WhatsApp Financial Assistant
 * Server entry point
 */

require('dotenv').config();



const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
require('./config/firebase');
const { handleWebhook, handleHealthCheck } = require('./controllers/webhookController');
const { rateLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

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
      model: 'claude-haiku-4-5-20251001',
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
// MERCADO PAGO — CRIAR PAGAMENTO
// ─────────────────────────────────────────────
app.post('/create-payment', async (req, res) => {
  try {
    const { plan, userId, userEmail, userName } = req.body;
    if(!plan || !userId) return res.status(400).json({ error: 'Dados inválidos' });

    const prices = { monthly: 9.90, yearly: 89.90 };
    const labels = { monthly: 'Mensal', yearly: 'Anual' };
    const price = prices[plan] || 9.90;
    const label = labels[plan] || 'Mensal';

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
        payer: {
          email: userEmail || '',
          name: userName || ''
        },
        external_reference: userId + '|' + plan,
        back_urls: {
          success: 'https://allofinancas.netlify.app?payment=success',
          failure: 'https://allofinancas.netlify.app?payment=failure',
          pending: 'https://allofinancas.netlify.app?payment=pending'
        },
        auto_return: 'approved',
        notification_url: 'https://finny-bot.onrender.com/webhook-mp'
      })
    });

    const data = await response.json();
    if(!data.init_point) return res.status(500).json({ error: 'Erro ao criar pagamento' });
    res.json({ url: data.init_point });
  } catch(e) {
    console.error('MP error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// MERCADO PAGO — WEBHOOK
// ─────────────────────────────────────────────
app.post('/webhook-mp', async (req, res) => {
  try {
    res.sendStatus(200); // Responde imediatamente para o MP

    const { type, data } = req.body;
    if(type !== 'payment') return;

    const paymentId = data?.id;
    if(!paymentId) return;

    // Busca detalhes do pagamento
    const pmtRes = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
      headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN }
    });
    const pmt = await pmtRes.json();

    if(pmt.status !== 'approved') return;

    // external_reference = userId|plan
    const [userId, plan] = (pmt.external_reference || '').split('|');
    if(!userId) return;

    // Ativa PRO no Firestore
    const { getDb } = require('./config/firebase');
    const db = getDb();
    await db.collection('users').doc(userId).set({
      isPro: true,
      proSince: new Date().toISOString(),
      proPlan: plan || 'monthly',
      proPaymentId: String(paymentId)
    }, { merge: true });

    console.log('✅ PRO ativado para:', userId);
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
      model: 'claude-haiku-4-5-20251001',
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
app.get('/', (req, res) => res.json({ service: 'FinnyBot', status: 'running' }));

/**
 * WhatsApp Webhook — Twilio sends POST with form body
 * Z-API sends POST with JSON body
 */
app.post('/webhook', handleWebhook);

/**
 * Twilio webhook verification (GET)
 */
app.get('/webhook', (req, res) => {
  res.status(200).send('Webhook endpoint active');
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
