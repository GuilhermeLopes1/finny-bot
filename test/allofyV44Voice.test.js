const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('V44 mantém modelo Pro forte e Realtime com segredo efêmero', () => {
  const env = read('.env.example');
  const realtime = read('src/controllers/allofyRealtimeController.js');
  assert.match(env, /OPENAI_AGENT_MODEL=gpt-5\.6/);
  assert.match(env, /OPENAI_REASONING_EFFORT=max/);
  assert.match(env, /OPENAI_REALTIME_MODEL=gpt-realtime-2\.1/);
  assert.match(realtime, /\/v1\/realtime\/client_secrets/);
  assert.doesNotMatch(realtime, /res\.json\([^\n]*OPENAI_API_KEY/);
});

test('V44 libera chat e voz rápida no Free, mas protege Live e ferramentas avançadas como Pro', () => {
  const server = read('src/server.js');
  assert.match(server, /app\.post\('\/allofy-chat', requireAllofyUser/);
  assert.match(server, /app\.post\('\/allofy-transcribe', requireAllofyUser/);
  assert.match(server, /app\.post\('\/allofy-realtime\/connect', requireAllofyPro/);
  assert.match(server, /app\.post\('\/allofy-tool', requireAllofyPro/);
  assert.match(server, /app\.post\('\/allofy-realtime\/end', requireAllofyPro/);
  assert.match(server, /app\.get\('\/allofy-usage', requireAllofyUser/);
  assert.match(server, /app\.post\('\/allofy-native\/realtime-token', authenticateNativeVoiceRequest/);
  assert.match(server, /app\.post\('\/allofy-native\/tool', authenticateNativeVoiceRequest/);
});

test('V44 mantém ações operacionais Pro e trilha de auditoria/desfazer', () => {
  const actions = read('src/services/allofyActionService.js');
  for (const tool of ['create_transaction','create_card_purchase','record_transfer','create_goal','add_goal_progress','create_debt','record_debt_payment','reconcile_bank_balance','delete_transaction','undo_allofy_action']) {
    assert.match(actions, new RegExp(`name: '${tool}'`));
  }
  assert.match(actions, /allofy_action_logs/);
  assert.match(actions, /widget_live/);
});

test('credencial nativa de voz é armazenada no servidor apenas como hash', () => {
  const native = read('src/services/nativeVoiceDeviceService.js');
  assert.match(native, /voiceKeyHash/);
  assert.match(native, /crypto\.randomBytes/);
  assert.match(native, /hashVoiceKey/);
  assert.match(native, /timingSafeEqual/);
  assert.doesNotMatch(native, /voiceDeviceKey:\s*device\.voiceDeviceKey/);
});

test('V44 mantém denúncia de conteúdo gerado por IA e desvincula voz no logout', () => {
  const server = read('src/server.js');
  const feedback = read('src/controllers/allofyFeedbackController.js');
  assert.match(server, /app\.post\('\/allofy-feedback', requireSignedInUser/);
  assert.match(server, /app\.post\('\/notifications\/native\/unbind', requireSignedInUser/);
  assert.match(feedback, /pending_review/);
  assert.match(feedback, /allofy_ai_feedback/);
});
