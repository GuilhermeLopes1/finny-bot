const crypto = require('crypto');
const { tools: readTools, executeAllofyTool } = require('../services/allofyTools');
const { actionTools, isActionTool, executeAllofyAction, normalizeSource } = require('../services/allofyActionService');
const { INSTRUCTIONS } = require('./allofyController');
const { assertConfigured } = require('../config/openai');
const logger = require('../utils/logger');
const {
  policyForProfile, consumeVoiceTranscription, reserveLiveSession,
  cancelLiveSession, handleFinishLive,
} = require('../services/allofyUsageService');

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';

function safetyIdentifier(uid) {
  return `allofy_${crypto.createHash('sha256').update(String(uid || 'unknown')).digest('hex').slice(0, 48)}`;
}

function realtimeTools() {
  return [...readTools, ...actionTools].map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function realtimeInstructions() {
  return `${INSTRUCTIONS}\n\nMODO AO VIVO:\n- Você está em uma conversa de voz em tempo real. Fale naturalmente em português brasileiro.\n- Priorize respostas curtas e fluidas, mas pense com cuidado antes de executar ferramentas.\n- Quando uma ferramenta for necessária, use-a antes de afirmar qualquer dado ou ação.\n- Depois de uma ação bem-sucedida, confirme em uma frase curta com valor, descrição e origem quando relevante.\n- Se a ferramenta devolver confirmation_required, explique exatamente o que será alterado e aguarde uma nova confirmação do usuário.\n- Aceite interrupções naturais: pare de falar e ouça quando o usuário interromper.\n- Nunca leia IDs técnicos, hashes ou tokens em voz alta.`;
}

function buildRealtimeSession({ native = false } = {}) {
  const input = {
    noise_reduction: { type: 'near_field' },
    transcription: {
      model: TRANSCRIBE_MODEL,
      language: 'pt',
      prompt: 'Português brasileiro. Contexto: Allofy, finanças pessoais, bancos, cartões, categorias, valores em reais, receitas, despesas, metas, dívidas e comandos do aplicativo.',
    },
    turn_detection: {
      type: 'semantic_vad',
      eagerness: 'medium',
      create_response: true,
      interrupt_response: true,
    },
  };
  const output = { voice: REALTIME_VOICE, speed: 1.0 };
  if (native) {
    input.format = { type: 'audio/pcm', rate: 24000 };
    output.format = { type: 'audio/pcm' };
  }
  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    instructions: realtimeInstructions(),
    output_modalities: ['audio'],
    tool_choice: 'auto',
    tools: realtimeTools(),
    audio: { input, output },
  };
}

async function createRealtimeCall(req, res) {
  const sdp = String(req.body?.sdp || '');
  if (!sdp || sdp.length > 120000) return res.status(400).json({ error: 'Oferta de áudio inválida.' });
  let lease = null;
  try {
    assertConfigured();
    lease = await reserveLiveSession(req.userIdentity.uid, req.userData || {});
    const session = buildRealtimeSession({ native: false });
    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', JSON.stringify(session));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_REALTIME_CONNECT_TIMEOUT_MS || 30000));
    let response;
    try {
      response = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Safety-Identifier': safetyIdentifier(req.userIdentity?.uid),
        },
        body: form,
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const answer = await response.text();
    if (!response.ok) {
      await cancelLiveSession(req.userIdentity.uid, lease?.leaseId, `openai_${response.status}`);
      logger.warn(`Realtime OpenAI HTTP ${response.status}: ${answer.slice(0, 600)}`);
      return res.status(response.status >= 500 ? 502 : response.status).json({ error: 'Não foi possível iniciar o modo ao vivo.', code: 'realtime_connect_failed' });
    }
    res.setHeader('Access-Control-Expose-Headers', 'X-Allofy-Live-Lease, X-Allofy-Live-Max-Seconds, X-Allofy-Live-Remaining-Seconds');
    res.setHeader('X-Allofy-Live-Lease', lease.leaseId);
    res.setHeader('X-Allofy-Live-Max-Seconds', String(lease.maxSeconds));
    res.setHeader('X-Allofy-Live-Remaining-Seconds', String(lease.usage.live.remainingSeconds ?? lease.maxSeconds));
    res.type('application/sdp').send(answer);
  } catch (error) {
    if (lease?.leaseId) await cancelLiveSession(req.userIdentity?.uid, lease.leaseId, 'connect_exception');
    logger.error(`Allofy realtime connect: ${error.message}`);
    const status = error.status || (error.code === 'openai_not_configured' ? 503 : 500);
    res.status(status).json({
      error: error.code === 'openai_not_configured' ? 'A IA ainda não foi configurada no servidor.' : error.message || 'Não foi possível iniciar o modo ao vivo.',
      code: error.code || 'realtime_error', usage: error.usage || null,
    });
  }
}

async function createNativeRealtimeSecret(req, res) {
  let lease = null;
  try {
    assertConfigured();
    lease = await reserveLiveSession(req.userIdentity.uid, req.userData || {});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_REALTIME_CONNECT_TIMEOUT_MS || 30000));
    let response;
    try {
      response = await fetch(REALTIME_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': safetyIdentifier(req.userIdentity?.uid),
        },
        body: JSON.stringify({ session: buildRealtimeSession({ native: true }) }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.value) {
      await cancelLiveSession(req.userIdentity.uid, lease?.leaseId, `secret_${response.status}`);
      logger.warn(`Realtime secret HTTP ${response.status}: ${JSON.stringify(data).slice(0, 600)}`);
      return res.status(response.status >= 500 ? 502 : response.status || 502).json({ error: 'Não foi possível iniciar a voz do widget.', code: 'realtime_secret_failed' });
    }
    return res.json({
      value: data.value,
      expiresAt: data.expires_at || data.expiresAt || null,
      model: REALTIME_MODEL,
      sampleRate: 24000,
      voice: REALTIME_VOICE,
      leaseId: lease.leaseId,
      maxSeconds: lease.maxSeconds,
      remainingSeconds: lease.usage.live.remainingSeconds,
    });
  } catch (error) {
    if (lease?.leaseId) await cancelLiveSession(req.userIdentity?.uid, lease.leaseId, 'secret_exception');
    logger.error(`Allofy native realtime secret: ${error.message}`);
    const status = error.status || (error.code === 'openai_not_configured' ? 503 : 500);
    return res.status(status).json({ error: error.message || 'Não foi possível iniciar a voz do widget.', code: error.code || 'realtime_secret_error', usage: error.usage || null });
  }
}

async function executeRealtimeTool(req, res) {
  const name = String(req.body?.name || '').trim();
  const args = req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {};
  if (!name) return res.status(400).json({ error: 'Ferramenta obrigatória.' });
  try {
    const uid = req.userIdentity.uid;
    let result;
    if (isActionTool(name)) {
      result = await executeAllofyAction(name, args, uid, {
        source: normalizeSource(req.body?.source || (req.userIdentity?.nativeVoice ? 'widget_live' : 'live')),
        requestId: String(req.body?.requestId || ''),
        userMessage: String(req.body?.userMessage || ''),
      });
    } else {
      // Para sessões ao vivo, leituras sempre buscam o Firestore mais recente.
      result = await executeAllofyTool(name, args, uid, null, { userMessage: String(req.body?.userMessage || '') });
    }
    return res.json(result);
  } catch (error) {
    logger.warn(`Allofy realtime tool ${name}: ${error.message}`);
    return res.status(500).json({ ok: false, error: 'Não foi possível executar essa ação no Allofy.', code: 'allofy_tool_failed' });
  }
}

async function transcribeAllofyAudio(req, res) {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Áudio obrigatório.' });
  try {
    assertConfigured();
    const policy = policyForProfile(req.userData || {});
    const usage = await consumeVoiceTranscription(req.userIdentity.uid, req.userData || {});
    const model = policy.transcribeModel || TRANSCRIBE_MODEL;
    const form = new FormData();
    const mime = String(req.file.mimetype || 'audio/webm').slice(0, 80);
    const filename = String(req.file.originalname || 'allofy-voice.webm').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
    form.append('file', new Blob([req.file.buffer], { type: mime }), filename);
    form.append('model', model);
    form.append('language', 'pt');
    form.append('prompt', 'Português brasileiro. Contexto: Allofy, finanças pessoais, nomes de bancos, cartões, categorias, valores em reais, receitas, despesas, metas e dívidas.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS || 60000));
    let response;
    try {
      response = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Safety-Identifier': safetyIdentifier(req.userIdentity?.uid),
        },
        body: form,
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Transcrição HTTP ${response.status}`), { status: response.status });
    const transcript = String(data.text || '').trim();
    if (!transcript) return res.status(422).json({ error: 'Não consegui entender o áudio.' });
    return res.json({ text: transcript, model, usage });
  } catch (error) {
    logger.error(`Allofy transcribe: ${error.message}`);
    const status = error.status === 429 ? 429 : error.code === 'openai_not_configured' ? 503 : 500;
    return res.status(status).json({ error: status === 429 ? error.message : 'Não foi possível transcrever o áudio agora.', code: error.code || 'transcribe_error', usage: error.usage || null });
  }
}

module.exports = {
  createRealtimeCall,
  createNativeRealtimeSecret,
  executeRealtimeTool,
  transcribeAllofyAudio,
  realtimeTools,
  buildRealtimeSession,
  REALTIME_MODEL,
  handleFinishLive,
};
