const { getDb, admin } = require('../config/firebase');
const { createResponse, outputText } = require('../config/openai');
const { tools: readTools, executeAllofyTool, financialOverview } = require('../services/allofyTools');
const { actionTools, isActionTool, executeAllofyAction, normalizeSource } = require('../services/allofyActionService');
const logger = require('../utils/logger');
const { cleanAllofyFormatting } = require('../utils/textFormatting');
const { policyForProfile, consumeCommand } = require('../services/allofyUsageService');

const tools = [...readTools, ...actionTools];
const FREE_READ_TOOLS = new Set([
  'get_app_capabilities','get_app_overview','get_financial_overview','search_transactions',
  'get_accounts_and_cards','get_categories','get_planning'
]);
const FREE_ACTION_TOOLS = new Set(['create_transaction','create_card_purchase']);

function toolsetForProfile(profile = {}) {
  const policy = policyForProfile(profile);
  if (policy.features.advancedActions) return { policy, tools };
  return {
    policy,
    tools: [
      ...readTools.filter(tool => FREE_READ_TOOLS.has(tool.name)),
      ...actionTools.filter(tool => FREE_ACTION_TOOLS.has(tool.name)),
    ],
  };
}

function freeInstructions(policy) {
  if (policy.features.advancedActions) return '';
  return `

PLANO GRATUITO — REGRAS:
- Você é a versão Essencial do Allofy. Continue útil, clara e inteligente, mas use somente as ferramentas disponibilizadas nesta sessão.
- Você pode consultar visão geral, saldos, cartões, categorias, planejamento e transações, além de registrar receita, despesa e compra no cartão.
- Transferências, criação/alteração de metas e dívidas, criação de contas/cartões/categorias, conciliação, exclusões, memória permanente e modo Live são recursos Pro.
- Quando o usuário pedir uma ação Pro, explique em uma frase que ela exige Allofy Pro e diga o que ele ainda pode fazer no modo gratuito. Não finja que executou.
- Seja econômica em texto para manter o modo gratuito viável.`;
}

const INSTRUCTIONS = `Você é o Allofy, agente financeiro operacional do aplicativo Allo Finanças.
Responda sempre em português brasileiro, com clareza, objetividade e linguagem adequada para celular.

MISSÃO:
- Entender profundamente os dados financeiros do usuário e, quando ele pedir, EXECUTAR ações dentro do Allofy por ferramentas verificadas.
- Você pode consultar e registrar dados do aplicativo. Você NÃO acessa banco real, não envia dinheiro, não compra ativos, não paga boletos e não executa operações fora do Allofy.
- Uma ação só aconteceu quando a ferramenta retornar ok=true e mutated=true. Nunca diga que criou, alterou, apagou ou transferiu algo sem essa confirmação.

REGRAS DE DADOS — OBRIGATÓRIAS:
- Para qualquer afirmação sobre cadastros ou finanças do usuário, consulte uma ferramenta. Nunca invente saldo, gasto, conta, cartão, data, categoria ou status.
- Para comandos de lançamento simples e claros, execute diretamente: “gastei 35 no almoço” pode criar despesa; “recebi 2000 de salário” pode criar receita.
- Se o usuário disser que foi no cartão, use create_card_purchase; se disser uma conta bancária, use create_transaction com account. Não trate cartão como conta bancária.
- Quando houver duas contas/cartões/categorias compatíveis ou faltar um dado indispensável, NÃO escolha arbitrariamente: use o erro/choices da ferramenta e faça uma pergunta curta.
- Em criação de transação, status padrão é paid quando o usuário descreve algo que já aconteceu; use pending quando ele disser que ainda vai pagar/receber.
- Ao registrar transferência, deixe claro que isso apenas registra e ajusta saldos dentro do Allofy; não movimenta dinheiro real.
- Reconcile de saldo, exclusões e alterações em massa são de alto impacto. Siga confirmation_required e peça confirmação explícita antes de chamar de novo com confirmed=true.
- Para exclusão, nunca considere a primeira ordem como confirmação final. Primeiro identifique o lançamento e peça confirmação; só apague após uma nova mensagem inequívoca do usuário confirmando.
- Se o usuário disser “desfaz”, “volta” ou “foi errado” logo após uma ação do Allofy, use undo_allofy_action.
- No plano Pro, trate pedidos de edição como operações reais: use edit_transactions para corrigir ou mover lançamentos, delete_bank_account para excluir contas com segurança, bulk_delete_transactions para exclusões em massa e manage_app_entities para demais cadastros.
- Você tem autonomia operacional sobre os dados do próprio usuário dentro do Allo. Não responda “não consigo alterar” sem antes verificar se uma ferramenta disponível executa a mudança.
- Para pedidos complexos, faça todas as leituras e chamadas necessárias em sequência até concluir a tarefa inteira. Não pare após alterar apenas o primeiro item.
- Alterações em massa devem usar IDs reais retornados pelas ferramentas de leitura. Nunca invente identificadores.
- A autonomia não inclui plano/assinatura, role/admin, Google Play Billing, credenciais, coleções internas da IA ou qualquer dado de outro usuário.
- Depois de qualquer ferramenta de escrita, use o resultado retornado como fonte de verdade. Se precisar consultar o efeito na mesma resposta, faça uma nova ferramenta de leitura.
- O Allo salva a conta bancária escolhida na transação pelo campo bankId. Resolva esse identificador e nunca conclua que a transação não tem conta sem pesquisar.
- A categoria normalmente é salva pelo identificador category. Cartão usa cardId; benefício usa benefitId.
- Quando o usuário pedir por uma conta específica, use search_transactions com account ou get_account_activity. Aceite apelido, instituição ou identificador.
- Quando pedir uma data específica, use exactDate AAAA-MM-DD. Para intervalos, use custom com startDate/endDate. date/dataCompra é a data financeira; createdAt é criação do registro.
- Diferencie transação normal de compra no cartão. Compras modernas ficam em cardTransactions e retornam kind='card_purchase'.
- Em resumos de gastos, não conte transferências entre contas, despesas cobertas por benefício nem pagamento de fatura como gasto novo. Compras do cartão já representam o gasto.
- Separe pago, pendente, parcial e cancelado. Pendências não entram no saldo realizado.
- Para “resumo do mês atual”, use get_financial_overview period='month'. Para “resumo completo/detalhado/tudo”, use suggestedExecutiveResponse como base factual.
- Faturas abertas são compromissos. Use commitmentAnalysis.uniqueCashOutflow para necessidade de caixa sem dupla contagem.
- Dívidas cadastradas devem aparecer no resumo completo mesmo sem transação da parcela.
- Se a busca não encontrar nada, tente uma busca menos restritiva antes de afirmar que o dado não existe.

SEGURANÇA E QUALIDADE:
- Nunca peça senha, CVV, token, chave privada ou número completo de cartão.
- Não forneça nem execute recomendação financeira de alto risco como certeza. Diferencie informação, estimativa e sugestão.
- Não mova dinheiro real nem afirme possuir integração bancária quando não possui.
- Salve memória somente quando o usuário pedir explicitamente para lembrar preferência não sensível.
- Ações mutáveis são auditadas e podem ser desfeitas quando a ferramenta indicar undoable=true.

REGRAS DE RESPOSTA:
- Seja objetivo. Em uma ação bem-sucedida, confirme o que foi feito e os valores essenciais.
- A interface exibe texto puro. Não use Markdown (#, **, tabelas ou linhas decorativas).
- Para organizar, use títulos simples, linhas em branco e marcador • quando necessário.
- Se a ferramenta devolver suggestedResponse, use-o como base factual sem remover pendências ou trocar valores.
- Se faltarem dados, diga exatamente o que falta.`;

function normalizeIntentText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}
function currentMonthNameNormalized() {
  return normalizeIntentText(new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date()));
}
function isDirectSummaryRequest(text) { return /(quero|me da|me de|faz|faca|gere|mostre|passe|preciso|puxa|monte)/.test(text); }
function wantsCurrentMonthCompleteSummary(message) {
  const text = normalizeIntentText(message);
  return isDirectSummaryRequest(text) && /(resumo|balanco|visao geral|fechamento)/.test(text)
    && /(completo|detalhado|tudo|separando|separa|gui.*luh|luh.*gui)/.test(text)
    && new RegExp(`mes atual|deste mes|desse mes|do mes|${currentMonthNameNormalized()}`).test(text);
}
function wantsCurrentMonthSimpleSummary(message) {
  const text = normalizeIntentText(message);
  return isDirectSummaryRequest(text) && /(resumo|balanco|visao geral)/.test(text)
    && new RegExp(`mes atual|deste mes|desse mes|do mes|${currentMonthNameNormalized()}`).test(text)
    && !/(completo|detalhado|tudo|separando|separa|gui.*luh|luh.*gui)/.test(text);
}

function historyRef(uid) { return getDb().collection('allofy_conversations').doc(uid).collection('messages'); }
async function loadHistory(uid, limit = 18) {
  const snap = await historyRef(uid).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
}
async function saveMessage(uid, role, content) {
  await historyRef(uid).add({ role, content: String(content).slice(0, 14000), createdAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function runAllofy(uid, profile, message, history, options = {}) {
  const { policy, tools: sessionTools } = toolsetForProfile(profile);
  if (wantsCurrentMonthCompleteSummary(message)) {
    const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null });
    return { reply: cleanAllofyFormatting(overview.suggestedExecutiveResponse), mutations: [], policy };
  }
  if (wantsCurrentMonthSimpleSummary(message)) {
    const overview = financialOverview(profile, { period: 'month', startDate: null, endDate: null, exactDate: null });
    return { reply: cleanAllofyFormatting(overview.suggestedResponse), mutations: [], policy };
  }

  const historyLimit = policy.tier === 'free' ? 8 : 18;
  const input = [
    ...history.slice(-historyLimit).map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: (item.role === 'assistant' ? cleanAllofyFormatting(item.content) : String(item.content))
        .slice(0, policy.tier === 'free' ? 3500 : 7000),
    })),
    { role: 'user', content: message },
  ];
  const mutations = [];
  let currentProfile = profile;
  const allowedToolNames = new Set(sessionTools.map(tool => tool.name));
  const callModel = () => createResponse({
    model: policy.agentModel,
    reasoning: { effort: policy.reasoningEffort },
    instructions: INSTRUCTIONS + freeInstructions(policy),
    input,
    tools: sessionTools,
    parallel_tool_calls: false,
    max_output_tokens: policy.tier === 'free' ? 1400 : 4200,
    text: { verbosity: policy.tier === 'free' ? 'low' : 'medium' },
  });
  let response = await callModel();
  const maxRounds = policy.tier === 'free' ? 5 : 20;

  for (let round = 0; round < maxRounds; round += 1) {
    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) return { reply: cleanAllofyFormatting(outputText(response)), mutations, policy };

    input.push(...(response.output || []));
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch (_) { args = {}; }
      let result;
      if (!allowedToolNames.has(call.name)) {
        result = { ok: false, code: 'pro_required', error: 'Esta ação exige o Allofy Pro.' };
      } else {
        try {
          if (isActionTool(call.name)) {
            result = await executeAllofyAction(call.name, args, uid, {
              userMessage: message,
              source: normalizeSource(options.source),
              requestId: call.call_id || call.id,
            });
            if (result?.mutated) {
              mutations.push({
                action: result.action, actionId: result.actionId, summary: result.summary,
                undoable: result.undoable === true, refresh: result.refresh || [], entity: result.entity || null,
              });
              currentProfile = null;
            }
          } else {
            result = await executeAllofyTool(call.name, args, uid, currentProfile, { userMessage: message });
          }
        } catch (error) {
          logger.warn(`Allofy tool ${call.name} falhou: ${error.message}`);
          result = { ok: false, error: 'Não foi possível executar esta ferramenta.', detail: error.message };
        }
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
    response = await callModel();
  }
  throw new Error('O Allofy excedeu o limite de ferramentas desta resposta');
}

async function handleAllofyChat(req, res) {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Escreva uma mensagem para o Allofy.' });
  if (message.length > 4000) return res.status(400).json({ error: 'A mensagem está muito longa.' });
  try {
    const uid = req.userIdentity.uid;
    const policy = policyForProfile(req.userData || {});
    const usage = await consumeCommand(uid, req.userData || {});
    const history = await loadHistory(uid, policy.tier === 'free' ? 8 : 18);
    await saveMessage(uid, 'user', message);
    const result = await runAllofy(uid, req.userData, message, history, { source: req.body?.source });
    const finalReply = result.reply || 'Não consegui montar uma resposta agora. Tente reformular a pergunta.';
    await saveMessage(uid, 'assistant', finalReply);
    res.json({
      reply: finalReply,
      mutations: result.mutations || [],
      usage,
      tier: policy.tier,
      remaining: usage.commands.remaining,
    });
  } catch (error) {
    logger.error(`Allofy chat error: ${error.message}`);
    const status = error.status === 429 ? 429 : error.status === 403 ? 403 : error.code === 'openai_not_configured' ? 503 : 500;
    res.status(status).json({
      error: status === 503 ? 'O Allofy ainda não foi configurado no servidor.' :
        status === 429 ? error.message : 'O Allofy não conseguiu responder agora. Tente novamente.',
      code: error.code || 'allofy_error',
      usage: error.usage || null,
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
      if (!snap.empty) { const batch = getDb().batch(); snap.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
    } while (!snap.empty);
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Allofy clear error: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível limpar a conversa.' });
  }
}

module.exports = { handleAllofyChat, getAllofyHistory, clearAllofyHistory, runAllofy, cleanAllofyFormatting, INSTRUCTIONS, tools, toolsetForProfile, FREE_READ_TOOLS, FREE_ACTION_TOOLS };
