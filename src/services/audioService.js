/**
 * Audio Service — transcribes WhatsApp voice messages via OpenAI Whisper
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');

/**
 * Download audio from a URL (supports Twilio/Z-API media URLs with auth)
 */
async function downloadAudio(mediaUrl, provider = 'twilio') {
  const tmpPath = path.join(os.tmpdir(), `wa_audio_${Date.now()}.ogg`);

  const config = { responseType: 'stream' };

  // Twilio requires HTTP basic auth
  if (provider === 'twilio') {
    config.auth = {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    };
  }

  // Z-API media URLs include token in query string — no extra auth needed
  if (provider === 'zapi') {
    config.headers = { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN };
  }

  const response = await axios.get(mediaUrl, config);

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tmpPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  logger.info(`Audio downloaded to ${tmpPath}`);
  return tmpPath;
}

/**
 * Transcribe audio file using OpenAI Whisper
 */
async function transcribeAudio(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'audio/ogg',
  });
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt'); // Force Brazilian Portuguese
  formData.append('response_format', 'json');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
    }
  );

  // Clean up temp file
  try {
    fs.unlinkSync(filePath);
  } catch (_) {}

  const text = response.data.text?.trim();
  logger.info(`Transcription: "${text}"`);
  return text;
}

/**
 * Full pipeline: download + transcribe
 */
async function processVoiceMessage(mediaUrl, provider = 'twilio') {
  try {
    logger.info(`Processing voice message from: ${mediaUrl}`);
    const filePath = await downloadAudio(mediaUrl, provider);
    const transcription = await transcribeAudio(filePath);
    return { success: true, text: transcription };
  } catch (error) {
    logger.error('Voice processing error:', error.message);
    return { success: false, text: null, error: error.message };
  }
}

module.exports = { processVoiceMessage, downloadAudio, transcribeAudio };
