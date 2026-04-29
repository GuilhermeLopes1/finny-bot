/**
 * WhatsApp Service — Abstraction layer for Twilio and Z-API providers
 */

const axios = require('axios');
const logger = require('../utils/logger');

const PROVIDER = process.env.WHATSAPP_PROVIDER || 'twilio';

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────

/**
 * Send a text message to a WhatsApp number
 */
async function sendMessage(to, body) {
  if (PROVIDER === 'twilio') {
    return sendViaTwilio(to, body);
  } else if (PROVIDER === 'zapi') {
    return sendViaZAPI(to, body);
  }
  throw new Error(`Unknown WhatsApp provider: ${PROVIDER}`);
}

/**
 * Send via Twilio
 */
async function sendViaTwilio(to, body) {
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  // Ensure "whatsapp:" prefix
  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;

  const msg = await client.messages.create({
    from: fromNumber,
    to: toNumber,
    body,
  });

  logger.info(`Twilio message sent: ${msg.sid}`);
  return msg;
}

/**
 * Send via Z-API
 */
async function sendViaZAPI(to, body) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;
  const securityToken = process.env.ZAPI_SECURITY_TOKEN;

  // Normalize phone number (remove + and country code prefix if needed)
  const phone = to.replace(/\D/g, '');

  const response = await axios.post(
    `https://api.z-api.io/instances/${instanceId}/token/${clientToken}/send-text`,
    { phone, message: body },
    { headers: { 'Client-Token': securityToken } }
  );

  logger.info(`Z-API message sent to ${phone}`);
  return response.data;
}

// ─────────────────────────────────────────────
// MESSAGE PARSING
// ─────────────────────────────────────────────

/**
 * Parse incoming webhook payload from Twilio
 */
function parseTwilioPayload(body) {
  const from = body.From || ''; // "whatsapp:+5511999999999"
  const messageType = detectMessageType(body);

  return {
    from,
    userId: from.replace('whatsapp:', '').replace(/\D/g, ''),
    type: messageType,
    text: body.Body || '',
    mediaUrl: body.MediaUrl0 || null,
    mediaContentType: body.MediaContentType0 || null,
    numMedia: parseInt(body.NumMedia || '0', 10),
    raw: body,
  };
}

/**
 * Parse incoming webhook payload from Z-API
 */
function parseZAPIPayload(body) {
  const phone = body.phone || body.from || '';
  const userId = phone.replace(/\D/g, '');
  const messageType = detectZAPIMessageType(body);

  return {
    from: phone,
    userId,
    type: messageType,
    text: body.text?.message || body.message || '',
    mediaUrl: body.audio?.audioUrl || body.image?.imageUrl || null,
    mediaContentType: messageType === 'audio' ? 'audio/ogg' : null,
    raw: body,
  };
}

function detectMessageType(twilioBody) {
  const contentType = twilioBody.MediaContentType0 || '';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('image/')) return 'image';
  if (twilioBody.Body) return 'text';
  return 'unknown';
}

function detectZAPIMessageType(body) {
  if (body.type === 'ReceivedCallback') {
    if (body.audio) return 'audio';
    if (body.image) return 'image';
    if (body.text) return 'text';
  }
  return 'unknown';
}

/**
 * Unified payload parser — auto-detects provider
 */
function parseIncomingMessage(body, provider = PROVIDER) {
  if (provider === 'twilio') return parseTwilioPayload(body);
  if (provider === 'zapi') return parseZAPIPayload(body);
  return parseTwilioPayload(body); // default
}

// ─────────────────────────────────────────────
// TWILIO WEBHOOK VALIDATION
// ─────────────────────────────────────────────

/**
 * Validate Twilio webhook signature
 */
function validateTwilioSignature(req) {
  if (process.env.NODE_ENV !== 'production') return true; // Skip in dev

  const twilio = require('twilio');
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

module.exports = {
  sendMessage,
  parseIncomingMessage,
  validateTwilioSignature,
};
