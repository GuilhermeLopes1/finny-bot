const pdfParse = require('pdf-parse');
const { createStructuredResponse } = require('../config/openai');
const { summarizeTransactions, asNumber } = require('../services/allofyTools');
const logger = require('../utils/logger');

const IMPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    transactions: { type: 'array', maxItems: 300, items: {
      type: 'object', additionalProperties: false,
      properties: {
        desc: { type: 'string' }, amount: { type: 'number', minimum: 0 },
        type: { type: 'string', enum: ['expense', 'income'] },
        date: { type: ['string', 'null'] }, category: { type: 'string' },
      }, required: ['desc', 'amount', 'type', 'date', 'category'],
    } },
    warnings: { type: 'array', maxItems: 20, items: { type: 'string' } },
  }, required: ['transactions', 'warnings'],
};

const IMPORT_INSTRUCTIONS = `Extraia somente transações financeiras que estejam realmente presentes no documento enviado.
Retorne datas em YYYY-MM-DD quando identificáveis; caso contrário use null.
Valores devem ser positivos e o campo type deve indicar expense ou income.
Não invente lançamentos, não complete valores ausentes e não duplique itens.
Ignore cabeçalhos, saldo anterior, limite e totais que não sejam uma transação individual.
Use categorias curtas em português brasileiro.`;

async function importFromInput(input) {
  return createStructuredResponse({
    instructions: IMPORT_INSTRUCTIONS,
    input,
    name: 'allo_import_transactions', schema: IMPORT_SCHEMA, maxOutputTokens: 4000,
  });
}

async function handlePdfImport(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Envie um arquivo PDF.' });
    const parsed = await pdfParse(req.file.buffer);
    const text = String(parsed.text || '').trim();
    if (!text) return res.status(400).json({ error: 'O PDF não possui texto legível.' });
    const result = await importFromInput([{ role: 'user', content: `Fatura ou extrato bancário:\n${text.slice(0, 90000)}` }]);
    res.json({ text: JSON.stringify(result), transactions: result.transactions, warnings: result.warnings });
  } catch (error) {
    logger.error(`PDF import OpenAI: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível analisar este PDF.' });
  }
}

async function handleAiAnalysis(req, res) {
  try {
    const task = String(req.body?.task || 'financial_analysis');
    if (task === 'financial_analysis') {
      const profile = req.userData || {};
      const transactions = [...(profile.transactions || []), ...(profile.cardTransactions || [])];
      const context = {
        currentMonth: summarizeTransactions(transactions, 'month'),
        lastMonth: summarizeTransactions(transactions, 'last_month'),
        accounts: (profile.banks || []).length,
        cards: (profile.cards || []).length,
        goals: (profile.goals || []).slice(0, 20),
        debts: (profile.debts || []).slice(0, 20),
        vaults: (profile.cofres || []).slice(0, 20),
      };
      const month = context.currentMonth;
      const totalDebt = context.debts.reduce((sum, debt) => sum + Math.max(0, asNumber(debt.total) - asNumber(debt.paid)), 0);
      let score = 100;
      if (month.balance < 0) score -= 30;
      if (month.income > 0 && month.expenses / month.income > 0.9) score -= 20;
      if (month.income > 0 && totalDebt > month.income * 0.5) score -= 25;
      if (month.pending > 0) score -= 10;
      score = Math.max(0, Math.min(100, score));
      const nivel = score < 40 ? 'crítico' : score < 70 ? 'atenção' : 'bom';
      const insight = await createStructuredResponse({
        instructions: 'Você é o analista financeiro do Allo Finanças. Escreva em português brasileiro. Use somente os dados verificados fornecidos. Seja específico e prudente. Nunca invente valores nem prometa resultados.',
        input: [{ role: 'user', content: `Analise este contexto financeiro verificado:\n${JSON.stringify(context)}` }],
        name: 'financial_analysis', maxOutputTokens: 1200,
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            insight_principal: { type: 'string' },
            alertas: { type: 'array', maxItems: 4, items: { type: 'string' } },
            conselhos: { type: 'array', minItems: 3, maxItems: 4, items: { type: 'string' } },
          },
          required: ['insight_principal', 'alertas', 'conselhos'],
        },
      });
      return res.json({ text: JSON.stringify({ score, nivel, ...insight }) });
    }

    if (task === 'import_text') {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Texto obrigatório.' });
      const result = await importFromInput([{ role: 'user', content: `Texto para importação:\n${text.slice(0, 90000)}` }]);
      return res.json({ text: JSON.stringify(result), transactions: result.transactions, warnings: result.warnings });
    }

    if (task === 'import_image') {
      const image = String(req.body?.image || '');
      const imageType = /^image\/(png|jpeg|webp)$/.test(req.body?.imageType || '') ? req.body.imageType : 'image/jpeg';
      if (!image || image.length > 14_000_000) return res.status(400).json({ error: 'Imagem inválida ou muito grande.' });
      const result = await importFromInput([{ role: 'user', content: [
        { type: 'input_text', text: 'Extraia as transações visíveis nesta imagem.' },
        { type: 'input_image', image_url: `data:${imageType};base64,${image}` },
      ] }]);
      return res.json({ text: JSON.stringify(result), transactions: result.transactions, warnings: result.warnings });
    }

    return res.status(400).json({ error: 'Tarefa de IA inválida.' });
  } catch (error) {
    logger.error(`AI analysis OpenAI: ${error.message}`);
    res.status(500).json({ error: 'A IA não conseguiu concluir esta análise.' });
  }
}

module.exports = { handlePdfImport, handleAiAnalysis, IMPORT_SCHEMA };
