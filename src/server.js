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
// AI ANALYSIS ROUTE
// ─────────────────────────────────────────────
app.post('/ai-analysis', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt obrigatório' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
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
