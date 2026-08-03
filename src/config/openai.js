const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const ALLOFY_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';

function assertConfigured() {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY não configurada');
    error.code = 'openai_not_configured';
    throw error;
  }
}

async function createResponse(payload) {
  assertConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 45000));

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ALLOFY_MODEL,
        store: false,
        reasoning: { effort: 'none' },
        ...payload,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || `OpenAI respondeu HTTP ${response.status}`);
      error.status = response.status;
      error.code = data?.error?.code || 'openai_request_failed';
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('A IA demorou mais que o esperado');
      timeoutError.code = 'openai_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text.trim();
  return (response?.output || [])
    .flatMap(item => item?.content || [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim();
}

async function createStructuredResponse({ instructions, input, name, schema, maxOutputTokens = 1600 }) {
  const response = await createResponse({
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    text: {
      format: {
        type: 'json_schema',
        name,
        strict: true,
        schema,
      },
    },
  });
  const raw = outputText(response);
  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.error('OpenAI structured output inválido', { name, responseId: response?.id });
    throw new Error('A IA retornou uma resposta estruturada inválida');
  }
}

module.exports = { ALLOFY_MODEL, createResponse, createStructuredResponse, outputText };
