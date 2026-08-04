const pdfParse = require('pdf-parse');
const { createStructuredResponse } = require('../config/openai');
const { summarizeTransactions, asNumber } = require('../services/allofyTools');
const logger = require('../utils/logger');

const IMPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    invoice: {
      type: 'object', additionalProperties: false,
      properties: {
        issuer: { type: ['string', 'null'] },
        cardHint: { type: ['string', 'null'] },
        lastFour: { type: ['string', 'null'] },
        dueDate: { type: ['string', 'null'] },
        closingDate: { type: ['string', 'null'] },
        statementMonth: { type: ['string', 'null'] },
        totalAmount: { type: ['number', 'null'], minimum: 0 },
      },
      required: ['issuer', 'cardHint', 'lastFour', 'dueDate', 'closingDate', 'statementMonth', 'totalAmount'],
    },
    transactions: { type: 'array', maxItems: 500, items: {
      type: 'object', additionalProperties: false,
      properties: {
        desc: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        type: { type: 'string', enum: ['expense', 'income'] },
        date: { type: ['string', 'null'] },
        category: { type: 'string' },
        installment: { type: ['string', 'null'] },
        installmentNumber: { type: ['integer', 'null'], minimum: 1 },
        installmentTotal: { type: ['integer', 'null'], minimum: 1 },
        originalAmount: { type: ['number', 'null'], minimum: 0 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['desc', 'amount', 'type', 'date', 'category', 'installment', 'installmentNumber', 'installmentTotal', 'originalAmount', 'confidence'],
    } },
    warnings: { type: 'array', maxItems: 30, items: { type: 'string' } },
    ignoredItems: { type: 'integer', minimum: 0 },
  }, required: ['invoice', 'transactions', 'warnings', 'ignoredItems'],
};

const IMPORT_INSTRUCTIONS = `Você é o importador de faturas do Allo Finanças.
Extraia somente compras, tarifas, juros, estornos e créditos que estejam realmente presentes no arquivo.

REGRAS OBRIGATÓRIAS:
1. Não transforme em compra: total da fatura, saldo anterior, limite, melhor dia de compra, pagamento mínimo, resumo por categoria, soma de parcelas, cabeçalhos, rodapés ou pagamentos da própria fatura.
2. Não invente datas, descrições ou valores. Quando o dia não estiver identificável, use date=null.
3. Valores devem ser positivos. Use type=expense para compras/tarifas/juros e type=income para estornos/créditos.
4. Retorne datas em YYYY-MM-DD. Quando o ano não estiver impresso, use o ano do mês de referência fornecido, de forma coerente com o ciclo da fatura.
5. Preserve o nome do estabelecimento, mas remova códigos inúteis, múltiplos espaços e textos repetidos.
6. Para "02/10", "PARC 2 DE 10" ou equivalente, preencha installment="2/10", installmentNumber=2 e installmentTotal=10. O amount deve ser o valor cobrado nesta fatura, não o total original.
7. originalAmount só deve ser preenchido quando o documento mostrar claramente o valor total original da compra.
8. Não duplique lançamentos que apareçam no resumo e também na lista detalhada.
9. Identifique issuer, cartão/final, vencimento, fechamento, mês da fatura e total da fatura somente quando houver evidência no arquivo.
10. Use categorias curtas em português brasileiro: Alimentação, Transporte, Moradia, Saúde, Educação, Lazer, Assinaturas, Compras, Serviços, Viagem, Tarifas, Juros, Estorno ou Outros.
11. confidence deve refletir a segurança da leitura. Use valor menor quando data, descrição ou valor estiverem ambíguos.
12. Informe warnings quando o documento estiver incompleto, com colunas ambíguas ou quando o total das linhas diferir bastante do total da fatura.`;

function importContext(req) {
  let selectedCard = req.body?.selectedCard || null;
  if (typeof selectedCard === 'string') {
    try { selectedCard = JSON.parse(selectedCard); } catch (_error) { selectedCard = { name: selectedCard }; }
  }
  return {
    fileName: String(req.file?.originalname || req.body?.fileName || '').slice(0, 180),
    referenceMonth: /^\d{4}-\d{2}$/.test(String(req.body?.referenceMonth || '')) ? String(req.body.referenceMonth) : null,
    selectedCard: selectedCard && typeof selectedCard === 'object' ? selectedCard : null,
    currentDate: new Date().toISOString().slice(0, 10),
  };
}

async function importFromInput(input, context = {}) {
  const contextualInstructions = `${IMPORT_INSTRUCTIONS}\n\nCONTEXTO FORNECIDO PELO APP (use apenas para resolver ano/cartão, nunca para inventar lançamentos):\n${JSON.stringify(context)}`;
  return createStructuredResponse({
    instructions: contextualInstructions,
    input,
    name: 'allo_import_invoice_v35', schema: IMPORT_SCHEMA, maxOutputTokens: 8000,
  });
}

async function handlePdfImport(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Envie um arquivo PDF.' });
    const parsed = await pdfParse(req.file.buffer);
    const text = String(parsed.text || '').trim();
    if (!text) return res.status(400).json({ error: 'O PDF não possui texto legível.' });
    const context = importContext(req);
    const result = await importFromInput([{ role: 'user', content: `Fatura de cartão ou extrato para importação:\n${text.slice(0, 120000)}` }], context);
    res.json({ text: JSON.stringify(result), invoice: result.invoice, transactions: result.transactions, warnings: result.warnings, ignoredItems: result.ignoredItems });
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
      const context = importContext(req);
      const result = await importFromInput([{ role: 'user', content: `Conteúdo estruturado ou texto de fatura para importação:\n${text.slice(0, 120000)}` }], context);
      return res.json({ text: JSON.stringify(result), invoice: result.invoice, transactions: result.transactions, warnings: result.warnings, ignoredItems: result.ignoredItems });
    }

    if (task === 'import_image') {
      const image = String(req.body?.image || '');
      const imageType = /^image\/(png|jpeg|webp)$/.test(req.body?.imageType || '') ? req.body.imageType : 'image/jpeg';
      if (!image || image.length > 14_000_000) return res.status(400).json({ error: 'Imagem inválida ou muito grande.' });
      const context = importContext(req);
      const result = await importFromInput([{ role: 'user', content: [
        { type: 'input_text', text: `Extraia as compras visíveis nesta imagem de fatura. Contexto: ${JSON.stringify(context)}` },
        { type: 'input_image', image_url: `data:${imageType};base64,${image}` },
      ] }]);
      return res.json({ text: JSON.stringify(result), invoice: result.invoice, transactions: result.transactions, warnings: result.warnings, ignoredItems: result.ignoredItems });
    }

    return res.status(400).json({ error: 'Tarefa de IA inválida.' });
  } catch (error) {
    logger.error(`AI analysis OpenAI: ${error.message}`);
    res.status(500).json({ error: 'A IA não conseguiu concluir esta análise.' });
  }
}

module.exports = { handlePdfImport, handleAiAnalysis, IMPORT_SCHEMA };
