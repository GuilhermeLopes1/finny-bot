const { getDb, admin } = require('../config/firebase');
const { createResponse, outputText } = require('../config/openai');
const { tools, executeAllofyTool } = require('../services/allofyTools');
const logger = require('../utils/logger');

const INSTRUCTIONS = `Você é o Allofy, assistente inteligente do aplicativo Allo Finanças.
Responda sempre em português brasileiro, de forma clara, prática e acolhedora.

Regras obrigatórias:
- Para qualquer afirmação sobre os dados financeiros do usuário, consulte uma ferramenta. Nunca invente saldo, gasto, data ou cadastro.
- Explique cálculos de forma simples e diferencie fato, estimativa e sugestão.
- Não prometa rentabilidade e não dê recomendação financeira como certeza. Em decisões importantes, mostre riscos e alternativas.
- Você pode responder dúvidas gerais estáveis. Para fatos atuais que não consegue verificar, diga isso com transparência.
- Você tem acesso somente de leitura aos dados financeiros. Não diga que criou, alterou ou apagou lançamentos.
- Salve memória somente quando o usuário pedir para lembrar uma preferência não sensível. Nunca memorize senha, token, CVV ou número completo de cartão.
- Seja objetivo; use listas curtas quando melhorarem a leitura. Não use tabelas longas no celular.
- Se faltarem dados, diga exatamente o que falta e como o usuário pode cadastrar no app.`;

function historyRef(uid) {
  return getDb().collection('allofy_conversations').doc(uid).collection('messages');
}

async function loadHistory(uid, limit = 14) {
  const snap = await historyRef(uid).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
}

async function saveMessage(uid, role, content) {
  await historyRef(uid).add({
    role,
    content: String(content).slice(0, 12000),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function runAllofy(uid, profile, message, history) {
  const input = [
    ...history.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content).slice(0, 6000) })),
    { role: 'user', content: message },
  ];

  let response = await createResponse({
    instructions: INSTRUCTIONS,
    input,
    tools,
    parallel_tool_calls: false,
    max_output_tokens: 1800,
    text: { verbosity: 'medium' },
  });

  for (let round = 0; round < 6; round += 1) {
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
        result = { error: 'Não foi possível consultar estes dados.' };
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }

    response = await createResponse({
      instructions: INSTRUCTIONS,
      input,
      tools,
      parallel_tool_calls: false,
      max_output_tokens: 1800,
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
    const history = await loadHistory(uid, 14);
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
    res.json({ messages: items.map(x => ({ role: x.role, content: x.content })) });
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
