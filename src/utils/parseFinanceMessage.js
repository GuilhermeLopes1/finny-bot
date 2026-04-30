function parseBRCurrency(raw) {
  if (!raw) return null;
  let str = raw.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) str = str.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d+)$/.test(str))            str = str.replace(',', '.');
  const value = parseFloat(str);
  return isNaN(value) || value <= 0 ? null : value;
}

const VALUE_RE = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/;

function extractValue(text) {
  const withIndicator = text.match(
    new RegExp('r\\$\\s*(' + VALUE_RE.source + ')|(' + VALUE_RE.source + ')(?=\\s*(?:reais|real|conto|pilas?))')
  );
  const cleaned = text
    .replace(/\b(dia|dias|às|as|hora|horas)\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ');
  const fallback = cleaned.match(VALUE_RE);
  const raw = withIndicator ? (withIndicator[1] ?? withIndicator[2]) : fallback?.[0];
  return raw ? parseBRCurrency(raw) : null;
}

const testes = [
  ['gastei 50 no mercado',              50],
  ['paguei R$ 1.200,50 de aluguel',     1200.50],
  ['recebi 1200 de salário',            1200],
  ['gastei no dia 12 o uber',           null],
  ['paguei 30 de uber no dia 5',        30],
  ['ganhei 500 reais de freela',        500],
  ['comprei dia 01/04 por 80',          80],
  ['entrou 2024 hoje',                  null],
  ['gastei 1,5 no café',                1.5],
  ['paguei 5000 de décimo terceiro',    5000],
  ['gastei 150 no mercado dia 03/05',   150],
  ['foi 12 no lanche',                  12],
  ['paguei 1.200 de aluguel',           1200],
  ['ganhei 3.500,00 de salário',        3500],
  ['gastei 99.90 no restaurante',       99.90],
];

let ok = 0, fail = 0;
testes.forEach(([msg, esperado]) => {
  const resultado = extractValue(msg);
  const passed = resultado === esperado;
  console.log((passed ? '✅' : '❌'), msg.padEnd(42), '→', String(resultado).padEnd(8), '(esperado:', esperado, ')');
  passed ? ok++ : fail++;
});
console.log('\n' + ok + '/' + testes.length + ' testes passaram');

// Testa pix
console.log('\n── Teste "pix" ──');
const incomeKeywords  = ['recebi','ganhei','entrou','pagaram','caiu','depositaram','transferiram'];
const expenseKeywords = ['gastei','paguei','comprei','foi','gasto','saiu','cobrado','cobrada','debitou'];
[
  ['paguei via pix 50',   'expense'],
  ['recebi pix de 200',   'income'],
  ['pix de 100',          'unknown'],
  ['gastei 30 no pix',    'expense'],
].forEach(([msg, esperado]) => {
  const t = msg.toLowerCase();
  let type = 'unknown';
  if      (incomeKeywords.some(k => t.includes(k)))  type = 'income';
  else if (expenseKeywords.some(k => t.includes(k))) type = 'expense';
  console.log((type === esperado ? '✅' : '❌'), msg.padEnd(28), '→', type);
});

// Testa dateUtils ontem
console.log('\n── Teste "ontem" na virada de mês ──');
// Simula dia 1 de maio → ontem deve ser 30 de abril
const fakeNow = new Date('2024-05-01T10:00:00Z');
const yesterday = new Date(fakeNow);
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
console.log('Hoje (UTC):', fakeNow.toISOString().slice(0,10));
console.log('Ontem calculado:', yesterday.toISOString().slice(0,10), yesterday.toISOString().slice(0,10) === '2024-04-30' ? '✅' : '❌');

// ─── Classificação de tipo ────────────────────────────────────────────────
const incomeKeywords  = ['recebi','ganhei','entrou','pagaram','caiu','depositaram','transferiram'];
const expenseKeywords = ['gastei','paguei','comprei','foi','gasto','saiu','cobrado','cobrada','debitou'];

function detectType(text) {
  const t = text.toLowerCase();
  if (incomeKeywords.some(k => t.includes(k)))  return 'income';
  if (expenseKeywords.some(k => t.includes(k))) return 'expense';
  return 'unknown';
}

// ─── Categorização básica ─────────────────────────────────────────────────
const CATEGORY_MAP = [
  [['uber','99','taxi','táxi','ônibus','metro','metrô','gasolina','combustível','posto'], 'Transporte'],
  [['mercado','supermercado','feira','hortifruti'],                                       'Mercado'],
  [['restaurante','ifood','almoço','janta','lanche','café','pizza','hamburguer'],         'Alimentação'],
  [['aluguel'],                                                                           'Moradia'],
  [['salário','salario','freela','freelance','décimo','decimo'],                          'Renda'],
  [['farmácia','farmacia','remédio','remedio','médico','medico','saúde'],                 'Saúde'],
  [['luz','água','agua','internet','telefone','conta'],                                   'Contas'],
];

function detectCategory(text) {
  const t = text.toLowerCase();
  for (const [keywords, category] of CATEGORY_MAP) {
    if (keywords.some(k => t.includes(k))) return category;
  }
  return 'Outros';
}

// ─── Export principal ─────────────────────────────────────────────────────
async function parseFinanceMessage(text, userId) {
  const lower  = text.toLowerCase();
  const amount = extractValue(lower);
  const type   = detectType(lower);
  const category = detectCategory(lower);

  return {
    type,
    amount,
    category,
    originalText: text,
  };
}

module.exports = { parseFinanceMessage };
