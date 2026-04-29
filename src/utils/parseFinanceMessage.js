const { mapCategory } = require('./categoryMapper');
const db = require('../config/firebase').getDb();

async function parseFinanceMessage(text, userId) {
  if (!text) return { type: 'unknown' };

  text = text.toLowerCase().trim();

  // 💰 pegar valor
  const valueMatch = text.match(/(\d+[.,]?\d*)/);
  const amount = valueMatch ? parseFloat(valueMatch[1].replace(',', '.')) : null;

  if (!amount) return { type: 'unknown' };

  // tipo
  const incomeKeywords = ['recebi', 'ganhei', 'entrou', 'pix', 'pagaram'];
  const expenseKeywords = ['gastei', 'paguei', 'comprei', 'foi', 'gasto'];

  let type = 'unknown';

  if (incomeKeywords.some(k => text.includes(k))) type = 'income';
  else if (expenseKeywords.some(k => text.includes(k))) type = 'expense';
  else type = 'expense';

  // categoria base
  let category = text
    .replace(/(\d+[.,]?\d*)/, '')
    .replace(
      /(gastei|paguei|comprei|foi|gasto|recebi|ganhei|entrou|pix|pagaram)/g,
      ''
    )
    .trim();

  if (!category) {
    category = type === 'income' ? 'renda' : 'geral';
  }

  // 🔥 IA QUE APRENDE
  const snapshot = await db
    .collection('users')
    .doc(userId)
    .collection('learning')
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (text.includes(data.keyword)) {
      return {
        type,
        amount,
        category: data.category,
        originalText: category
      };
    }
  }

  // fallback normal
  const finalCategory = mapCategory(category, type);

  return {
    type,
    amount,
    category: finalCategory,
    originalText: category
  };
}

module.exports = { parseFinanceMessage };