/**
 * Intent Parser
 * Orchestrates AI intent detection and maps to Firebase query filters
 */

const { parseDateReference, getMonthRange, getWeekRange, getTodayRange, getLastMonthRange } = require('../utils/dateUtils');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// CATEGORY NORMALIZATION
// ─────────────────────────────────────────────

const CATEGORY_ALIASES = {
  // Alimentação
  mercado: 'alimentação',
  supermercado: 'alimentação',
  ifood: 'alimentação',
  restaurante: 'alimentação',
  comida: 'alimentação',
  lanche: 'alimentação',
  pizza: 'alimentação',
  hamburguer: 'alimentação',
  café: 'alimentação',
  padaria: 'alimentação',
  delivery: 'alimentação',
  rappi: 'alimentação',

  // Transporte
  uber: 'transporte',
  '99': 'transporte',
  táxi: 'transporte',
  taxi: 'transporte',
  gasolina: 'transporte',
  combustível: 'transporte',
  ônibus: 'transporte',
  metrô: 'transporte',
  passagem: 'transporte',
  estacionamento: 'transporte',
  pedágio: 'transporte',

  // Moradia
  aluguel: 'moradia',
  condomínio: 'moradia',
  luz: 'moradia',
  energia: 'moradia',
  água: 'moradia',
  internet: 'moradia',
  gás: 'moradia',

  // Saúde
  farmácia: 'saúde',
  remédio: 'saúde',
  médico: 'saúde',
  consulta: 'saúde',
  academia: 'saúde',
  plano: 'saúde',
  dentista: 'saúde',

  // Assinaturas
  netflix: 'assinaturas',
  spotify: 'assinaturas',
  amazon: 'assinaturas',
  prime: 'assinaturas',
  hbo: 'assinaturas',
  disney: 'assinaturas',
  youtube: 'assinaturas',

  // Educação
  curso: 'educação',
  escola: 'educação',
  faculdade: 'educação',
  livro: 'educação',
  udemy: 'educação',

  // Lazer
  cinema: 'lazer',
  show: 'lazer',
  teatro: 'lazer',
  viagem: 'lazer',
  bar: 'lazer',
  balada: 'lazer',

  // Roupas
  roupa: 'roupas',
  tênis: 'roupas',
  sapato: 'roupas',
  vestuário: 'roupas',

  // Tecnologia
  celular: 'tecnologia',
  notebook: 'tecnologia',
  computador: 'tecnologia',
  eletrônico: 'tecnologia',

  // Salário / receitas
  salário: 'salário',
  salario: 'salário',
  freelance: 'freelance',
  freela: 'freelance',
  renda: 'salário',
  pagamento: 'salário',
};

/**
 * Normalize a category string using aliases
 */
function normalizeCategory(raw) {
  if (!raw) return 'outros';
  const lower = raw.toLowerCase().trim();
  return CATEGORY_ALIASES[lower] || lower;
}

// ─────────────────────────────────────────────
// FILTER BUILDER
// ─────────────────────────────────────────────

/**
 * Convert AI filters object to Firestore query params
 */
function buildFirestoreFilters(aiFilters = {}) {
  const filters = {};

  // Period
  const period = aiFilters.period || 'month';
  let range;

  switch (period) {
    case 'today':
      range = getTodayRange();
      break;
    case 'week':
      range = getWeekRange();
      break;
    case 'month':
      range = getMonthRange();
      break;
    case 'last_month':
      range = getLastMonthRange();
      break;
    case 'custom':
      if (aiFilters.startDate) range = { start: new Date(aiFilters.startDate), end: new Date(aiFilters.endDate || new Date()) };
      break;
    default:
      range = getMonthRange();
  }

  if (range) {
    filters.startDate = range.start;
    filters.endDate = range.end;
  }

  // Category
  if (aiFilters.category) {
    filters.category = normalizeCategory(aiFilters.category);
  }

  // Type
  if (aiFilters.type && aiFilters.type !== 'all') {
    filters.type = aiFilters.type;
  }

  return filters;
}

/**
 * Get human-readable period label in Portuguese
 */
function getPeriodLabel(period) {
  const labels = {
    today: 'hoje',
    week: 'esta semana',
    month: 'este mês',
    last_month: 'o mês passado',
  };
  return labels[period] || 'este mês';
}

// ─────────────────────────────────────────────
// AMOUNT PARSER (fallback if AI misses it)
// ─────────────────────────────────────────────

/**
 * Try to extract a numeric amount from free text
 * Handles: "50", "R$50", "R$ 50,00", "50 reais", "50 conto"
 */
function extractAmount(text) {
  const patterns = [
    /R\$\s*([\d.,]+)/i,
    /([\d.,]+)\s*(?:reais|real|conto|pila|mangos?)/i,
    /\b(\d+(?:[.,]\d{1,2})?)\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const raw = match[1].replace('.', '').replace(',', '.');
      const value = parseFloat(raw);
      if (!isNaN(value) && value > 0) return value;
    }
  }
  return null;
}

module.exports = {
  normalizeCategory,
  buildFirestoreFilters,
  getPeriodLabel,
  extractAmount,
  CATEGORY_ALIASES,
};
