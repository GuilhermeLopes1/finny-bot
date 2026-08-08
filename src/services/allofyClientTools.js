const PAGE_DESTINATIONS = Object.freeze({
  dashboard: 'Início', transactions: 'Extrato', banks: 'Contas', cards: 'Cartões', goals: 'Metas',
  debts: 'Dívidas', reports: 'Relatórios', categories: 'Categorias', import_invoice: 'Importar fatura',
  profile: 'Perfil', vaults: 'Cofres', calendar: 'Calendário', calculator: 'Calculadora', support: 'Suporte',
  budget: 'Orçamento', benefits: 'Benefícios', allo_points: 'AlloPoints', allofy: 'Allofy',
  add_income: 'Nova receita', add_expense: 'Nova despesa', transfer: 'Transferência', add_card: 'Novo cartão',
  add_bank: 'Nova conta', add_goal: 'Nova meta', add_debt: 'Nova dívida', add_category: 'Nova categoria',
  add_card_purchase: 'Nova compra no cartão', update_card_invoice: 'Atualizar fatura', pay_card_invoice: 'Pagar fatura',
});

const destinationEnum = Object.keys(PAGE_DESTINATIONS);
const nullableString = { type: ['string', 'null'], maxLength: 160 };

const clientTools = [
  {
    type: 'function',
    name: 'get_current_app_context',
    description: 'Obtém o contexto VISUAL mais recente da tela atual do Allo Finanças (página, modal aberto, textos visíveis e campos em edição). Use antes de responder referências como “essa tela”, “esse cartão”, “aqui”, “isso”, “o que estou vendo” ou quando precisar saber onde o usuário está no app. Não use esse contexto como substituto das ferramentas financeiras do servidor para confirmar saldos/valores.',
    strict: true,
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'navigate_app',
    description: 'Navega com segurança dentro do próprio Allo Finanças ou abre um formulário sem salvar nada. Use quando o usuário pedir “abre”, “vai para”, “me leva”, “mostra a tela”, “abre nova receita/despesa” etc. Para add_income/add_expense, pode pré-preencher campos fornecidos; o usuário continuará vendo o formulário e nada será salvo apenas por abrir/preencher.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        destination: { type: 'string', enum: destinationEnum },
        description: nullableString,
        amount: { type: ['number', 'null'], minimum: 0 },
        category: nullableString,
        account: nullableString,
        card: nullableString,
        date: { type: ['string', 'null'], maxLength: 20 },
      },
      required: ['destination', 'description', 'amount', 'category', 'account', 'card', 'date'],
    },
  },
];

const CLIENT_TOOL_NAMES = new Set(clientTools.map(tool => tool.name));

function cleanString(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitizeFields(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 24).map(item => ({
    id: cleanString(item?.id, 80),
    label: cleanString(item?.label, 120),
    value: cleanString(item?.value, 180),
  })).filter(item => item.id || item.label || item.value);
}

function sanitizeAppContext(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > 18000) raw = raw.slice(0, 18000);
    try { data = JSON.parse(raw); } catch (_) { data = null; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const page = data.page && typeof data.page === 'object' ? data.page : {};
  const modal = data.modal && typeof data.modal === 'object' ? data.modal : null;
  const reference = data.reference && typeof data.reference === 'object' ? data.reference : null;
  return {
    version: 1,
    page: {
      key: cleanString(page.key, 60),
      title: cleanString(page.title, 120),
      visibleText: cleanString(page.visibleText, 4200),
    },
    modal: modal ? {
      id: cleanString(modal.id, 100),
      title: cleanString(modal.title, 160),
      visibleText: cleanString(modal.visibleText, 2200),
      fields: sanitizeFields(modal.fields),
    } : null,
    reference: reference ? {
      type: cleanString(reference.type, 60),
      id: cleanString(reference.id, 160),
      name: cleanString(reference.name, 180),
    } : null,
    capturedAt: cleanString(data.capturedAt, 40),
  };
}

function compactAppContext(context) {
  const safe = sanitizeAppContext(context);
  if (!safe) return 'Tela atual não informada pelo aplicativo.';
  const lines = [];
  lines.push(`Página: ${safe.page.title || safe.page.key || 'não identificada'} (${safe.page.key || 'sem chave'}).`);
  if (safe.reference?.name) lines.push(`Referência em foco: ${safe.reference.type || 'item'} “${safe.reference.name}”${safe.reference.id ? ` [id ${safe.reference.id}]` : ''}.`);
  if (safe.modal) {
    lines.push(`Modal/formulário aberto: ${safe.modal.title || safe.modal.id || 'sim'}.`);
    if (safe.modal.fields.length) lines.push(`Campos visíveis: ${safe.modal.fields.map(f => `${f.label || f.id}=${f.value || 'vazio'}`).join(' | ')}`);
    if (safe.modal.visibleText) lines.push(`Texto do modal: ${safe.modal.visibleText}`);
  }
  if (safe.page.visibleText) lines.push(`Texto visível da página: ${safe.page.visibleText}`);
  return lines.join('\n').slice(0, 7600);
}

function isClientTool(name) { return CLIENT_TOOL_NAMES.has(String(name || '')); }

function executeClientTool(name, args = {}, context = {}) {
  if (name === 'get_current_app_context') {
    return { ok: true, source: 'client_ui', context: sanitizeAppContext(context.appContext) };
  }
  if (name === 'navigate_app') {
    const destination = cleanString(args.destination, 60);
    if (!Object.prototype.hasOwnProperty.call(PAGE_DESTINATIONS, destination)) {
      return { ok: false, code: 'invalid_destination', error: 'Destino do aplicativo não permitido.' };
    }
    const clientAction = {
      type: 'navigate_app',
      destination,
      prefill: {
        description: args.description == null ? null : cleanString(args.description, 160),
        amount: args.amount == null || !Number.isFinite(Number(args.amount)) ? null : Math.max(0, Number(args.amount)),
        category: args.category == null ? null : cleanString(args.category, 120),
        account: args.account == null ? null : cleanString(args.account, 120),
        card: args.card == null ? null : cleanString(args.card, 120),
        date: args.date == null ? null : cleanString(args.date, 20),
      },
    };
    return {
      ok: true,
      mutated: false,
      clientAction,
      summary: `Abrindo ${PAGE_DESTINATIONS[destination]} no aplicativo.`,
    };
  }
  return { ok: false, code: 'unknown_client_tool', error: 'Ferramenta de interface desconhecida.' };
}

module.exports = { clientTools, isClientTool, executeClientTool, sanitizeAppContext, compactAppContext, PAGE_DESTINATIONS };
