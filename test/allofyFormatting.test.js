const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanAllofyFormatting } = require('../src/utils/textFormatting');

test('remove marcações de markdown que aparecem cruas no aplicativo', () => {
  const raw = '# Resumo\n\n**Realizado**\n- Receitas: **R$ 10,00**\n---\n- Saldo: -R$ 5,00';
  const clean = cleanAllofyFormatting(raw);
  assert.equal(clean, 'Resumo\n\nRealizado\n• Receitas: R$ 10,00\n\n• Saldo: -R$ 5,00');
});
