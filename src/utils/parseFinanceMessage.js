
/**
 * parseFinanceMessage.js
 * Utilitário para extrair valor, tipo e categoria de mensagens financeiras em português.
 */

// ─────────────────────────────────────────────
// PARSING DE VALOR (BRL)
// ─────────────────────────────────────────────

function parseBRCurrency(raw) {
  if (!raw) return null;
  let str = raw.trim();
  // Formato "1.200,50" → remove pontos de milhar, troca vírgula por ponto
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) str = str.replace(/\./g, '').replace(',', '.');
  // Formato "50,90" → troca vírgula por ponto
  else if (/^\d+(,\d+)$/.test(str)) str = str.replace(',', '.');
  const value = parseFloat(str);
  return isNaN(value) || value <= 0 ? null : value;
}

const VALUE_RE = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/;

function extractValue(text) {
  // Tenta capturar valores precedidos de "R$" ou seguidos de "reais/real/conto/pilas"
  const withIndicator = text.match(
    new RegExp(
      'r\\$\\s*(' + VALUE_RE.source + ')|(' + VALUE_RE.source + ')(?=\\s*(?:reais|real|conto|pilas?))'
    )
  );

  // Remove datas e anos antes de tentar fallback genérico
  const cleaned = text
    .replace(/\b(dia|dias|às|as|hora|horas)\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ');

  const fallback = cleaned.match(VALUE_RE);
  const raw = withIndicator ? (withIndicator[1] ?? withIndicator[2]) : fallback?.[0];
  return raw ? parseBRCurrency(raw) : null;
}

// ─────────────────────────────────────────────
// DETECÇÃO DE TIPO (income / expense)
// ─────────────────────────────────────────────

const INCOME_KEYWORDS = [
  'recebi', 'ganhei', 'entrou', 'pagaram', 'caiu', 'depositaram',
  'transferiram', 'recebo', 'receita', 'renda', 'salário', 'salario',
];

const EXPENSE_KEYWORDS = [
  'gastei', 'paguei', 'comprei', 'foi', 'gasto', 'saiu', 'cobrado',
  'cobrada', 'debitou', 'debitado', 'pago', 'compra', 'gasta',
];

function detectType(text) {
  const t = text.toLowerCase();
  if (INCOME_KEYWORDS.some((k) => t.includes(k)))  return 'income';
  if (EXPENSE_KEYWORDS.some((k) => t.includes(k))) return 'expense';
  return 'unknown';
}

// ─────────────────────────────────────────────
// DETECÇÃO DE CATEGORIA
// ─────────────────────────────────────────────

const CATEGORY_MAP = [
  [
    ['uber', '99', 'taxi', 'táxi', 'ônibus', 'onibus', 'metro', 'metrô',
     'gasolina', 'combustível', 'combustivel', 'posto', 'estacionamento',
     'pedágio', 'pedagio', 'passagem'],
    'Transporte',
  ],
  [
    ['mercado', 'supermercado', 'feira', 'hortifruti', 'açougue', 'acougue',
     'padaria', 'mercearia'],
    'Mercado',
  ],
  [
    ['restaurante', 'ifood', 'almoço', 'almoco', 'jantar', 'janta', 'lanche',
     'café', 'cafe', 'pizza', 'hamburguer', 'hamburger', 'delivery', 'rappi',
     'comida', 'refeição', 'refeicao'],
    'Alimentação',
  ],
  [
    ['aluguel', 'condomínio', 'condominio', 'iptu', 'moradia'],
    'Moradia',
  ],
  [
    ['salário', 'salario', 'freela', 'freelance', 'décimo', 'decimo',
     'bônus', 'bonus', 'comissão', 'comissao', 'renda', 'honorários'],
    'Renda',
  ],
  [
    ['farmácia', 'farmacia', 'remédio', 'remedio', 'médico', 'medico',
     'consulta', 'exame', 'hospital', 'plano de saúde', 'saúde', 'saude',
     'dentista', 'psicólogo', 'psicologo'],
    'Saúde',
  ],
  [
    ['luz', 'energia', 'água', 'agua', 'internet', 'telefone', 'celular',
     'netflix', 'spotify', 'assinatura', 'conta', 'gás', 'gas'],
    'Contas',
  ],
  [
    ['escola', 'faculdade', 'curso', 'livro', 'educação', 'educacao',
     'mensalidade', 'aula', 'material'],
    'Educação',
  ],
  [
    ['roupa', 'calçado', 'calcado', 'tênis', 'tenis', 'camisa', 'vestido',
     'loja', 'shopping', 'vestuário', 'vestuario'],
    'Vestuário',
  ],
  [
    ['academia', 'ginástica', 'ginastica', 'esporte', 'natação', 'natacao',
     'futebol', 'musculação', 'musculacao'],
    'Esporte',
  ],
  [
    ['cinema', 'show', 'teatro', 'ingresso', 'lazer', 'viagem', 'hotel',
     'passeio', 'diversão', 'diversao'],
    'Lazer',
  ],
];

function detectCategory(text) {
  const t = text.toLowerCase();
  for (const [keywords, category] of CATEGORY_MAP) {
    if (keywords.some((k) => t.includes(k))) return category;
  }
  return 'Outros';
}

// ─────────────────────────────────────────────
// APRENDIZADO DO USUÁRIO (Firestore)
// ─────────────────────────────────────────────

/**
 * Tenta buscar uma categoria aprendida para o texto no histórico do usuário.
 * Retorna null se não encontrar ou se o Firebase não estiver disponível.
 */
async function learnedCategory(text, userId) {
  try {
    if (!userId) return null;
    const db = require('../config/firebase').getDb();
    const snap = await db
      .collection('users')
      .doc(userId)
      .collection('learning')
      .doc(text.toLowerCase().trim())
      .get();
    return snap.exists ? snap.data()?.category || null : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// EXPORT PRINCIPAL
// ─────────────────────────────────────────────

/**
 * Analisa uma mensagem de texto livre em português e retorna
 * os campos financeiros estruturados.
 *
 * @param {string} text     - Texto da mensagem (ex: "gastei 50 no mercado")
 * @param {string} [userId] - ID do usuário no Firestore (para aprendizado)
 * @returns {Promise<{
 *   type: 'income'|'expense'|'unknown',
 *   amount: number|null,
 *   category: string,
 *   originalText: string,
 * }>}
 */
async function parseFinanceMessage(text, userId) {
  const lower    = (text || '').toLowerCase().trim();
  const amount   = extractValue(lower);
  const type     = detectType(lower);

  // Prioriza categoria aprendida pelo usuário; cai no detector estático
  const learned  = await learnedCategory(lower, userId);
  const category = learned || detectCategory(lower);

  return {
    type,
    amount,
    category,
    originalText: text,
  };
}

module.exports = { parseFinanceMessage };
