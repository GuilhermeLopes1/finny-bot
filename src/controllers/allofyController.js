const { getDb, admin } = require('../config/firebase');
const { createResponse, outputText } = require('../config/openai');
const { tools, executeAllofyTool } = require('../services/allofyTools');
const logger = require('../utils/logger');

const INSTRUCTIONS = `Você é o Allofy, assistente inteligente do aplicativo Allo Finanças.
Responda sempre em português brasileiro, com clareza, objetividade e linguagem adequada para celular.

REGRAS DE DADOS — OBRIGATÓRIAS:
- Para qualquer afirmação sobre cadastros ou finanças do usuário, consulte uma ferramenta. Nunca invente saldo, gasto, conta, cartão, data, categoria ou status.
- O Allo salva a conta bancária escolhida na transação pelo campo bankId. A ferramenta resolve esse identificador e devolve account com nome/apelido, instituição, tipo e saldo. Nunca conclua que uma transação não tem conta antes de pesquisar por account/bankId.
- A categoria normalmente é salva pelo identificador category e deve ser resolvida na lista de categorias. O cartão usa cardId; o benefício usa benefitId.
- Quando o usuário pedir por uma conta específica, use search_transactions com o filtro account ou get_account_activity. Aceite apelido, instituição ou identificador.
- Quando o usuário pedir por uma data específica, use exactDate no formato AAAA-MM-DD. Para intervalos, use custom com startDate e endDate. date/dataCompra é a data financeira; createdAt é somente a data de criação do registro.
- search_transactions devolve detalhes completos: conta, cartão, categoria, status, recorrência, observações, origem, transferências e parcelas. Use get_transaction_details quando precisar aprofundar um item.
- Diferencie transação normal de compra no cartão. Compras modernas ficam em cardTransactions e retornam kind='card_purchase'.
- Ao analisar cartões, invoiceTotal/invoice/totalOpen são valores de fatura. registeredPurchases mostra apenas compras cadastradas. invoiceSource='manual' significa que o usuário informou o valor real, que não pode ser ignorado.
- Em resumos de gastos, não conte transferências entre contas, despesas cobertas por benefício nem pagamento de fatura como um novo gasto, pois isso geraria dupla contagem. Compras do cartão já representam o gasto.
- Separe pago, pendente, parcial e cancelado. Pendências não entram no saldo realizado, mas devem ser apresentadas separadamente quando forem relevantes.
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
- Se faltarem dados, diga exatamente o que falta e em qual área do app cadastrar.`;

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
  const input = [
    ...history.map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content).slice(0, 7000),
    })),
    { role: 'user', content: message },
  ];

  let response = await createResponse({
    instructions: INSTRUCTIONS,
    input,
    tools,
    parallel_tool_calls: false,
    max_output_tokens: 2600,
    text: { verbosity: 'medium' },
  });

  for (let round = 0; round < 8; round += 1) {
    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) return outputText(response);

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
      max_output_tokens: 2600,
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
    res.json({ messages: items.map(item => ({ role: item.role, content: item.content })) });
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

module.exports = { handleAllofyChat, getAllofyHistory, clearAllofyHistory, runAllofy };
