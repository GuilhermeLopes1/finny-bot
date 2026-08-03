const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponse, outputText, ALLOFY_MODEL } = require('../src/config/openai');

test('configura Luna e desativa armazenamento nas respostas', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let captured;
  process.env.OPENAI_API_KEY = 'chave-de-teste';
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'resp_test', output_text: 'ok' }) };
  };
  try {
    const response = await createResponse({ input: 'teste' });
    assert.equal(outputText(response), 'ok');
    assert.equal(captured.model, ALLOFY_MODEL);
    assert.equal(captured.store, false);
    assert.deepEqual(captured.reasoning, { effort: 'none' });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('extrai texto quando output_text não está presente', () => {
  assert.equal(outputText({ output: [{ content: [{ type: 'output_text', text: 'resposta' }] }] }), 'resposta');
});
