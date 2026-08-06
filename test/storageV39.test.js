const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('FinnyBot grava transações novas em subcoleções V39', () => {
  const source = read('src/services/firebaseService.js');
  assert.match(source, /collection\('transactions'\)\.doc\(id\)\.set/);
  assert.doesNotMatch(source, /userRef\.set\(\{\s*transactions\s*\}/);
  assert.match(source, /migrateLegacyProfileV39/);
});

test('Allofy e análise carregam contexto das subcoleções V39', () => {
  const server = read('src/server.js');
  const auth = read('src/middleware/firebaseAuth.js');
  const tools = read('src/services/allofyTools.js');
  assert.match(server, /requireAllofyUser/);
  assert.match(auth, /hydrateProfile/);
  assert.match(tools, /return hydrateProfile\(uid\)/);
});

test('regras impedem escrita do cliente em pontos, ranking e coleções do Google Play', () => {
  const rules = read('firestore_rules.txt');
  assert.match(rules, /match \/ap_history\/\{documentId\}[\s\S]*allow create, update, delete: if false/);
  assert.match(rules, /match \/ap_ranking\/\{month\}[\s\S]*allow create, update, delete: if false/);
  assert.match(rules, /match \/google_play_purchases\/\{documentId\} \{ allow read, write: if false; \}/);
  assert.match(rules, /match \/google_play_rtdn_events\/\{documentId\} \{ allow read, write: if false; \}/);
  assert.match(rules, /'alloPoints'/);
});
