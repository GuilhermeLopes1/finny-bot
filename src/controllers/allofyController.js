const { getDb, admin } = require('../config/firebase');
const { createResponse, outputText } = require('../config/openai');
const { tools, executeAllofyTool, financialOverview } = require('../services/allofyTools');
const logger = require('../utils/logger');
const { cleanAllofyFormatting } = require('../utils/textFormatting');

const INSTRUCTIONS = `Você é o Allofy, assistente inteligente do aplicativo Allo Finanças.
Responda sempre em português brasileiro, com clareza, objetividade e linguagem adequada para celular.

REGRAS DE DADOS — OBRIGATÓRIAS:
- Para qualquer afirmação sobre cadastros ou finanças do usuário, consulte uma ferramenta. Nunca invente saldo, gasto, conta, cartão, data, categoria ou status.
- O Allo salva a conta bancária escolhida na transação pelo campo bankId. A ferramenta resolve esse identificador e devolve account com nome/apelido, instituição, tipo e saldo. Contas antigas podem ter apenas o nome completo, como “Nubank Gui” ou “Nubank Luh”, e também são reconhecidas. Nunca conclua que uma transação não tem conta antes de pesquisar por account/bankId.
- A categoria normalmente é salva pelo identificador category e deve ser resolvida na lista de categorias. O cartão usa cardId; o benefício usa benefitId.
- Quando o usuário pedir por uma conta específica, use search_transactions com o filtro account ou get_account_activity. Aceite apelido, instituição ou identificador.
- Quando o usuário pedir por uma data específica, use exactDate no formato AAAA-MM-DD. Para intervalos, use custom com startDate e endDate. date/dataCompra é a data financeira; createdAt é somente a data de criação do registro.
- search_transactions devolve detalhes completos: conta, cartão, categoria, status, recorrência, observações, origem, transferências e parcelas. Use get_transaction_details quando precisar aprofundar um item.
- Diferencie transação normal de compra no cartão. Compras modernas ficam em cardTransactions e retornam kind='card_purchase'.
- Ao analisar cartões, invoiceTotal/invoice/totalOpen são valores de fatura. registeredPurchases mostra apenas compras cadastradas. invoiceSource='manual' significa que o usuário informou o valor real, que não pode ser ignorado.
- Em resumos de gastos, não conte transferências entre contas, despesas cobertas por benefício nem pagamento de fatura como um novo gasto, pois isso geraria dupla contagem. Compras do cartão já representam o gasto.
- Separe pago, pendente, parcial e cancelado. Pendências não entram no saldo realizado, mas devem ser apresentadas separadamente quando forem relevantes.
- Para pedidos amplos como “quero um resumo do mês atual”, use get_financial_overview com period='month'. Apresente primeiro receitas realizadas, despesas realizadas e saldo; depois mostre obrigatoriamente as pendências do período, sua quantidade, os principais itens e o saldo projetado após elas.
- Quando o usuário disser “resumo completo”, “resumo detalhado”, “tudo do mês” ou pedir separação entre Gui e Luh, use suggestedExecutiveResponse como resposta-base obrigatória. Ele já inclui saldos bancários, realizado, pendências diretas, faturas, parcelas, dívidas, prioridades, cobertura do caixa e agrupamento por proprietário.
- Nas separações por proprietário, use o campo owner devolvido pelas ferramentas. Nomes exatos como Gui/Guilherme e Luh/Ludmilla/Ludmila são sinais válidos. Nunca coloque um item em “Sem vínculo identificado” se ele tiver bankId resolvido ou se o nome trouxer claramente um desses proprietários.
- Um nome genérico de instituição, como apenas “Nubank”, não deve ser usado para escolher arbitrariamente entre duas contas do mesmo banco. Nessa situação, informe que o vínculo específico não está determinado.
- Faturas abertas são compromissos de pagamento. Use commitmentAnalysis.uniqueCashOutflow para a necessidade de caixa sem sobreposições fortes; não faça a soma bruta por conta própria.
- Dívidas cadastradas devem aparecer no resumo completo mesmo que a parcela ainda não tenha virado uma transação. Mostre a parcela aberta do mês e o saldo devedor.
- get_financial_overview devolve pendingItems, pendingByAccount e suggestedResponse. Use esses campos. Nunca diga “pendências não separadas por conta” ou “não foi possível identificar a conta” sem antes verificar pendingByAccount e pendingItems.
- Em um resumo geral, não crie uma seção para cada conta sem o usuário pedir. Não liste contas sem movimentação. Não explique exclusões técnicas como transferências ou pagamento de fatura, a menos que isso seja necessário para esclarecer um valor ou que o usuário pergunte.
- Quando listar uma pendência, informe descrição, valor, data e conta vinculada. Se não houver conta vinculada no registro, diga somente “Sem conta vinculada”.
- “Conta” pode significar conta bancária ou conta a pagar. Use o contexto; quando houver ambiguidade, faça uma pergunta curta.
- Para perguntas sobre uma funcionalidade do aplicativo, consulte get_app_capabilities. Para perguntas amplas sobre o perfil, consulte get_app_overview e depois as ferramentas específicas.
- Você tem acesso somente de leitura aos dados financeiros. Não diga que criou, alterou ou apagou lançamentos.
- Se a busca não encontrar nada, informe os filtros usados e tente uma busca menos restritiva antes de afirmar que o dado não existe.

REGRAS DE RESPOSTA:
- Explique cálculos de forma simples e diferencie fato, estimativa e sugestão.
- Não prometa rentabilidade e não dê recomendação financeira como certeza. Em decisões importantes, mostre riscos e alternativas.
- Você pode responder dúvidas gerais estáveis. Para fatos atuais que não consegue verificar, diga isso com transparência.
- Salve memória somente quando o usuário pedir explicitamente para lembrar uma preferência não sensível. Nunca memorize senha, token, CVV ou número completo de cartão.
- Seja objetivo; use listas curtas quando melhorarem a leitura. Não use tabelas longas.
- A interface do Allofy exibe texto puro. Não use Markdown. Não use #, ##, **, __, linhas com --- nem asteriscos decorativos.
- Para organizar, use títulos simples em letras maiúsculas, linhas em branco e o marcador •. Use no máximo um emoji por seção quando realmente ajudar.
- Em resumos financeiros completos, mostre nesta ordem: visão geral e saldos bancários; realizado; compromissos líquidos do mês; separação por proprietário/conta; prioridades; saldo devedor; leitura rápida.
- Se a ferramenta devolver suggestedResponse, use-o como base factual e melhore apenas a redação, sem remover pendências ou trocar os valores.
- Se faltarem dados, diga exatamente o que falta e em qual área do app cadastrar.`;


function normalizeIntentText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

function currentMonthNameNormalized() {
  return normalizeIntentText(new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date()));
}

function isDirectSummaryRequest(text) {
  return /(quero|me da|me de|faz|faca|gere|mostre|passe|preciso|puxa|monte)/.test(text);
}

function wantsCurrentMonthCompleteSummary(message) {
  const text = normalizeIntentText(message);
  const asksSummary = /(resumo|balanco|visao geral|fechamento)/.test(text);
  const asksComplete = /(completo|detalhado|tudo|separando|separa|gui.*luh|luh.*gui)/.test(text);
  const currentMonth = new RegExp(`mes atual|deste mes|desse mes|do mes|${currentMonthNameNormalized()}`).test(text);
  return isDirectSummaryRequest(text) && asksSummary && asksComplete && currentMonth;
}

function wantsCurrentMonthSimpleSummary(message) {
  const text = normalizeIntentText(message);
  const currentMonth = new RegExp(`mes atual|deste mes|desse mes|do mes|${currentMonthNameNormalized()}`).test(text);
  return isDirectSummaryRequest(text) && /(resumo|balanco|visao geral)/.test(text)
    && currentMonth
    && !/(completo|detalhado|tudo|separando|separa|gui.*luh|luh.*gui)/.test(text);
}

function historyRef(uid) {
  return getDb().collection('allofy_conversations').doc(uid).collection('messages');
}

async function loadHistory(uid, limit = 18) {
  const snap = await historyRef(uid).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
}

async function saveMessage(uid, role, content) {
  await historyRef(uid).add({
    role,
    content: String(content).slice(0, 14000),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function runAllofy(uid, profile, message, history) {
  if (wantsCurrentMonthCompleteSummary(message)) {
    const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null });
    return cleanAllofyFormatting(overview.suggestedExecutiveResponse);
  }
  if (wantsCurrentMonthSimpleSummary(message)) {
    const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null });
    return cleanAllofyFormatting(overview.suggestedResponse);
  }

  const input = [
    ...history.map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: (item.role === 'assistant' ? cleanAllofyFormatting(item.content) : String(item.content)).slice(0, 7000),
    })),
    { role: 'user', content: message },
  ];

  let response = await createResponse({
    instructions: INSTRUCTIONS,
    input,
    tools,
    parallel_tool_calls: false,
    max_output_tokens: 3200,
    text: { verbosity: 'medium' },
  });

  for (let round = 0; round < 8; round += 1) {
    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) return cleanAllofyFormatting(outputText(response));

    input.push(...(response.output || []));
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch (_) { args = {}; }
      let result;
      try {
        result = await executeAllofyTool(call.name, args, uid, profile, { userMessage: message });
      } catch (error) {
        logger.warn(`Allofy tool ${call.name} falhou: ${error.message}`);
        result = { error: 'Não foi possível consultar estes dados.', detail: error.message };
      }
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }

    response = await createResponse({
      instructions: INSTRUCTIONS,
      input,
      tools,
      parallel_tool_calls: false,
      max_output_tokens: 3200,
      text: { verbosity: 'medium' },
    });
  }
  throw new Error('O Allofy excedeu o limite de consultas desta resposta');
}

async function handleAllofyChat(req, res) {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Escreva uma mensagem para o Allofy.' });
  if (message.length > 4000) return res.status(400).json({ error: 'A mensagem está muito longa.' });

  try {
    const uid = req.userIdentity.uid;
    const history = await loadHistory(uid, 18);
    await saveMessage(uid, 'user', message);
    const reply = await runAllofy(uid, req.userData, message, history);
    const finalReply = reply || 'Não consegui montar uma resposta agora. Tente reformular a pergunta.';
    await saveMessage(uid, 'assistant', finalReply);
    res.json({ reply: finalReply, remaining: req.aiUsage?.remaining ?? null });
  } catch (error) {
    logger.error(`Allofy chat error: ${error.message}`);
    const status = error.status === 429 ? 429 : error.code === 'openai_not_configured' ? 503 : 500;
    res.status(status).json({
      error: status === 503 ? 'O Allofy ainda não foi configurado no servidor.' : 'O Allofy não conseguiu responder agora. Tente novamente.',
      code: error.code || 'allofy_error',
    });
  }
}

async function getAllofyHistory(req, res) {
  try {
    const items = await loadHistory(req.userIdentity.uid, 30);
    res.json({ messages: items.map(item => ({ role: item.role, content: item.role === 'assistant' ? cleanAllofyFormatting(item.content) : item.content })) });
  } catch (error) {
    logger.error(`Allofy history error: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível carregar a conversa.' });
  }
}

async function clearAllofyHistory(req, res) {
  try {
    const ref = historyRef(req.userIdentity.uid);
    let snap;
    do {
      snap = await ref.limit(400).get();
      if (!snap.empty) {
        const batch = getDb().batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    } while (!snap.empty);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Allofy clear error: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível limpar a conversa.' });
  }
}

module.exports = { handleAllofyChat, getAllofyHistory, clearAllofyHistory, runAllofy, cleanAllofyFormatting };
