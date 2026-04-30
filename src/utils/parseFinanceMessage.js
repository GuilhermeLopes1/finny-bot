
const { mapCategory } = require('./categoryMapper');

// ✅ FIX #4: db lazy-loaded dentro da função para evitar crash
//    se o Firebase ainda não estiver inicializado no momento do require
function getDb() {
  return require('../config/firebase').getDb();
}

/**
 * Converte string de valor monetário BR para float
 * Suporta: "50", "1.200", "1.200,50", "1200.50", "1,5"
 *
 * ✅ FIX #1: regex anterior (\d+[.,]?\d*) não capturava valores
 *    completos como "1.200,50". Nova regex trata separadores de milhar
 *    e decimal no padrão brasileiro.
 */
function parseBRCurrency(raw) {
  if (!raw) return null;

  // Remove espaços
  let str = raw.trim();

  // Formato BR: 1.200,50 ou 1.200 → remove pontos de milhar, troca vírgula por ponto
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
    str = str.replace(/\./g, '').replace(',', '.');
  }
  // Formato com vírgula decimal sem milhar: 1200,50 ou 1,5
  else if (/^\d+(,\d+)$/.test(str)) {
    str = str.replace(',', '.');
  }
  // Formato padrão: 1200.50 ou 1200 — mantém como está

  const value = parseFloat(str);
  return isNaN(value) || value <= 0 ? null : value;
}

/**
 * Remove stopwords e preposições comuns do português para limpar a categoria
 *
 * ✅ FIX #3: versão anterior deixava lixo ("no", "de", "com", "na", etc.)
 *    na string de categoria após remover keywords e o valor.
 */
const STOPWORDS = [
  'no', 'na', 'nos', 'nas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'com', 'por', 'para', 'um', 'uma', 'o', 'a', 'os', 'as',
  'e', 'que', 'se', 'ao', 'aos', 'às',
];

function cleanCategory(text) {
  return text
    .split(/\s+/)
    .filter(word => word.length > 0 && !STOPWORDS.includes(word))
    .join(' ')
    .trim();
}

async function parseFinanceMessage(text, userId) {
  if (!text) return { type: 'unknown' };

  text = text.toLowerCase().trim();

  // ─── Extração de valor ───────────────────────────────────────────────────
  // ✅ FIX #1: nova regex captura formatos BR completos:
  //    "1.200,50"  "1.200"  "1200,50"  "1200.50"  "50"  "1,5"
  const valueMatch = text.match(/\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?/);
  const amount = valueMatch ? parseBRCurrency(valueMatch[0]) : null;

  if (!amount) return { type: 'unknown' };

  // ─── Detecção de tipo ────────────────────────────────────────────────────
  // ✅ FIX #2: removido o `else type = 'expense'` que classificava QUALQUER
  //    mensagem como gasto. Agora retorna 'unknown' se nenhuma keyword bater,
  //    evitando falsos positivos.
  const incomeKeywords = ['recebi', 'ganhei', 'entrou', 'pix', 'pagaram', 'caiu', 'depositaram', 'transferiram'];
  const expenseKeywords = ['gastei', 'paguei', 'comprei', 'foi', 'gasto', 'saiu', 'cobrado', 'cobrada', 'debitou'];

  let type = 'unknown';

  if (incomeKeywords.some(k => text.includes(k)))       type = 'income';
  else if (expenseKeywords.some(k => text.includes(k))) type = 'expense';
  // ← sem else: se não há keyword, permanece 'unknown'

  if (type === 'unknown') return { type: 'unknown' };

  // ─── Extração de categoria ───────────────────────────────────────────────
  // ✅ FIX #3: aplica cleanCategory para remover stopwords/preposições
  // ✅ FIX (regex R$): usa \b word boundary para não engolir letras de outras palavras
  const allKeywords = [...incomeKeywords, ...expenseKeywords].join('|');
  const keywordPattern = new RegExp(`(${allKeywords})`, 'g');

  let rawCategory = text
    .replace(valueMatch[0], '')            // remove o valor
    .replace(/\bR\$\s*/gi, '')             // remove "R$" com word boundary
    .replace(keywordPattern, '')           // remove as keywords
    .replace(/[^\w\sà-ú]/g, ' ')          // remove pontuação
    .trim();

  const category = cleanCategory(rawCategory) || (type === 'income' ? 'renda' : 'geral');

  // ─── Aprendizado do usuário (Firestore) ──────────────────────────────────
  // ✅ FIX #5: envolvido em try/catch — uma falha de rede não derruba o parser
  try {
    const db = getDb();
    const snapshot = await db
      .collection('users')
      .doc(userId)
      .collection('learning')
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.keyword && text.includes(data.keyword)) {
        return {
          type,
          amount,
          category: data.category,
          originalText: category,
          learnedCategory: true,   // flag para debug
        };
      }
    }
  } catch (err) {
    // Falha silenciosa: segue para o mapCategory padrão
    console.warn('⚠️ parseFinanceMessage: erro ao ler learning collection:', err.message);
  }

  // ─── Fallback: mapeamento de categoria ──────────────────────────────────
  const finalCategory = mapCategory(category, type);

  return {
    type,
    amount,
    category: finalCategory,
    originalText: category,
    learnedCategory: false,
  };
}

module.exports = { parseFinanceMessage, parseBRCurrency };
