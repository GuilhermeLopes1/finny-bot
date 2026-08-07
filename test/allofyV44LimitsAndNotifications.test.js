const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('V44 separa Allofy Essencial gratuito e Allofy Pro com limites mensais', () => {
  const env = read('.env.example');
  const usage = read('src/services/allofyUsageService.js');
  assert.match(env, /OPENAI_FREE_AGENT_MODEL=gpt-5\.6-luna/);
  assert.match(env, /ALLOFY_FREE_COMMANDS_MONTHLY=20/);
  assert.match(env, /ALLOFY_FREE_VOICE_COMMANDS_MONTHLY=5/);
  assert.match(env, /ALLOFY_PRO_COMMANDS_MONTHLY=150/);
  assert.match(env, /ALLOFY_PRO_LIVE_MINUTES_MONTHLY=25/);
  assert.match(env, /ALLOFY_LIVE_SESSION_MAX_MINUTES=10/);
  assert.match(usage, /allofy_usage/);
  assert.match(usage, /allofy_live_leases/);
  assert.match(usage, /reserveLiveSession/);
  assert.match(usage, /finishLiveSession/);
});

test('V44 gratuito só recebe ferramentas financeiras simples', () => {
  const controller = read('src/controllers/allofyController.js');
  assert.match(controller, /FREE_ACTION_TOOLS/);
  assert.match(controller, /'create_transaction'/);
  assert.match(controller, /'create_card_purchase'/);
  assert.match(controller, /Essencial do Allofy/);
  assert.match(controller, /toolsetForProfile/);
});

test('V44 envia notificação de resposta no suporte e alertas de franquia da IA', () => {
  const server = read('src/server.js');
  const notification = read('src/services/notificationService.js');
  const usage = read('src/services/allofyUsageService.js');
  assert.match(server, /\/admin\/support\/notify-reply/);
  assert.match(server, /Tem resposta nova para você/);
  assert.match(server, /open-support/);
  assert.match(notification, /supportMessages:\s*true/);
  assert.match(notification, /aiUsageAlerts:\s*true/);
  assert.match(usage, /Allofy Live está quase no limite|Allofy Live: franquia concluída/);
});
