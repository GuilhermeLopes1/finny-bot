const PERIODS = ['month', 'last_month', 'quarter', 'year', 'all'];

function database() {
  return require('../config/firebase').getDb();
}

function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const normalized = value.replace(/R\$|\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function transactionDate(item) {
  const raw = item?.date || item?.data || item?.createdAt || item?.timestamp;
  if (raw?.toDate) return raw.toDate();
  const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00`)
    : raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function periodRange(period = 'month', now = new Date()) {
  if (!PERIODS.includes(period)) period = 'month';
  if (period === 'all') return { start: null, end: null };
  if (period === 'last_month') return {
    start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    end: new Date(now.getFullYear(), now.getMonth(), 1),
  };
  if (period === 'quarter') return {
    start: new Date(now.getFullYear(), now.getMonth() - 2, 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
  if (period === 'year') return {
    start: new Date(now.getFullYear(), 0, 1),
    end: new Date(now.getFullYear() + 1, 0, 1),
  };
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
}

function inPeriod(item, period, now = new Date()) {
  const { start, end } = periodRange(period, now);
  if (!start) return true;
  const date = transactionDate(item);
  return Boolean(date && date >= start && date < end);
}

function normalizeType(item) {
  const type = String(item?.type || item?.tipo || '').toLowerCase();
  if (['income', 'receita', 'entrada'].includes(type)) return 'income';
  if (['expense', 'despesa', 'saida', 'saída'].includes(type)) return 'expense';
  return asNumber(item?.amount ?? item?.value ?? item?.valor) < 0 ? 'expense' : 'unknown';
}

function amountOf(item) {
  return Math.abs(asNumber(item?.amount ?? item?.value ?? item?.valor ?? item?.total));
}

function cleanTransaction(item) {
  return {
    description: String(item?.description || item?.desc || item?.name || item?.nome || 'Sem descrição').slice(0, 160),
    amount: amountOf(item),
    type: normalizeType(item),
    category: String(item?.category || item?.categoria || 'Outros').slice(0, 80),
    date: (() => {
      const date = transactionDate(item);
      if (!date) return null;
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    })(),
    status: String(item?.status || (item?.pending ? 'pending' : 'confirmed')).slice(0, 40),
    account: String(item?.bankName || item?.bank || item?.conta || item?.account || '').slice(0, 100),
  };
}

function summarizeTransactions(items, period = 'month', now = new Date()) {
  const filtered = (Array.isArray(items) ? items : []).filter(item => inPeriod(item, period, now));
  const summary = { period, income: 0, expenses: 0, balance: 0, count: filtered.length, pending: 0, byCategory: {} };
  for (const item of filtered) {
    const type = normalizeType(item);
    const amount = amountOf(item);
    const category = String(item?.category || item?.categoria || 'Outros');
    if (type === 'income') summary.income += amount;
    if (type === 'expense') {
      summary.expenses += amount;
      summary.byCategory[category] = (summary.byCategory[category] || 0) + amount;
    }
    if (item?.pending === true || String(item?.status || '').toLowerCase().includes('pend')) summary.pending += amount;
  }
  summary.balance = summary.income - summary.expenses;
  summary.byCategory = Object.fromEntries(Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 15));
  return summary;
}

const tools = [
  {
    type: 'function', name: 'get_financial_overview',
    description: 'Calcula receitas, despesas, saldo, pendências e categorias do usuário em um período.',
    strict: true,
    parameters: { type: 'object', properties: { period: { type: 'string', enum: PERIODS } }, required: ['period'], additionalProperties: false },
  },
  {
    type: 'function', name: 'search_transactions',
    description: 'Pesquisa transações reais do usuário com filtros.',
    strict: true,
    parameters: { type: 'object', properties: {
      period: { type: 'string', enum: PERIODS },
      type: { type: 'string', enum: ['income', 'expense', 'all'] },
      category: { type: ['string', 'null'] }, query: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['all', 'confirmed', 'pending'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }, required: ['period', 'type', 'category', 'query', 'status', 'limit'], additionalProperties: false },
  },
  {
    type: 'function', name: 'get_accounts_and_cards',
    description: 'Consulta contas bancárias, cartões e benefícios cadastrados.',
    strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function', name: 'get_planning',
    description: 'Consulta metas, dívidas e cofres do usuário.',
    strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function', name: 'get_driver_summary',
    description: 'Consulta o resumo do módulo motorista por período.',
    strict: true,
    parameters: { type: 'object', properties: { period: { type: 'string', enum: PERIODS } }, required: ['period'], additionalProperties: false },
  },
  {
    type: 'function', name: 'get_user_memory',
    description: 'Lê preferências não sensíveis que o usuário pediu para o Allofy lembrar.',
    strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function', name: 'save_user_memory',
    description: 'Salva preferências não sensíveis explicitamente informadas pelo usuário. Nunca salva senhas, tokens ou dados de cartão.',
    strict: true,
    parameters: { type: 'object', properties: { items: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 180 } } }, required: ['items'], additionalProperties: false },
  },
];

async function loadProfile(uid) {
  const snap = await database().collection('users').doc(uid).get();
  if (!snap.exists) throw new Error('Perfil financeiro não encontrado');
  return snap.data() || {};
}

async function executeAllofyTool(name, args, uid, prefetchedProfile = null, context = {}) {
  const profile = prefetchedProfile || await loadProfile(uid);
  const transactions = [...(profile.transactions || []), ...(profile.cardTransactions || [])];

  if (name === 'get_financial_overview') return summarizeTransactions(transactions, args.period);
  if (name === 'search_transactions') {
    const query = String(args.query || '').toLocaleLowerCase('pt-BR');
    const category = String(args.category || '').toLocaleLowerCase('pt-BR');
    return transactions.filter(item => inPeriod(item, args.period)).filter(item => {
      const clean = cleanTransaction(item);
      if (args.type !== 'all' && clean.type !== args.type) return false;
      if (category && !clean.category.toLocaleLowerCase('pt-BR').includes(category)) return false;
      if (query && !`${clean.description} ${clean.category} ${clean.account}`.toLocaleLowerCase('pt-BR').includes(query)) return false;
      if (args.status !== 'all' && clean.status !== args.status) return false;
      return true;
    }).sort((a, b) => (transactionDate(b)?.getTime() || 0) - (transactionDate(a)?.getTime() || 0)).slice(0, args.limit).map(cleanTransaction);
  }
  if (name === 'get_accounts_and_cards') return {
    banks: (profile.banks || []).slice(0, 30).map(x => ({ name: x.name || x.nome || x.bankName || 'Conta', balance: asNumber(x.balance ?? x.saldo), type: x.type || x.tipo || '' })),
    cards: (profile.cards || []).slice(0, 30).map(x => ({ name: x.name || x.nome || 'Cartão', invoice: asNumber(x.invoice ?? x.fatura ?? x.currentInvoice), limit: asNumber(x.limit ?? x.limite), dueDay: x.dueDay || x.vencimento || null })),
    benefits: (profile.benefits || []).slice(0, 20).map(x => ({ name: x.name || x.nome || 'Benefício', balance: asNumber(x.balance ?? x.saldo) })),
  };
  if (name === 'get_planning') return {
    goals: (profile.goals || []).slice(0, 30), debts: (profile.debts || []).slice(0, 30), vaults: (profile.cofres || []).slice(0, 30),
  };
  if (name === 'get_driver_summary') {
    const journeys = (profile.uberJornadas || []).filter(x => inPeriod(x, args.period));
    const rides = (profile.uberCorridas || []).filter(x => inPeriod(x, args.period));
    const expenses = (profile.uberGastos || []).filter(x => inPeriod(x, args.period));
    const fuel = (profile.uberAbastec || []).filter(x => inPeriod(x, args.period));
    return {
      period: args.period, journeys: journeys.length, rides: rides.length,
      grossRevenue: rides.reduce((sum, x) => sum + amountOf(x), 0),
      expenses: [...expenses, ...fuel].reduce((sum, x) => sum + amountOf(x), 0),
      vehicles: (profile.uberVeiculos || []).slice(0, 10).map(x => ({ name: x.name || x.modelo || x.placa || 'Veículo' })),
    };
  }
  if (name === 'get_user_memory') return { items: Array.isArray(profile.allofyMemory) ? profile.allofyMemory.slice(0, 30) : [] };
  if (name === 'save_user_memory') {
    if (!/(lembre|lembrar|guarde|memorize|não esqueça)/i.test(String(context.userMessage || ''))) {
      return { saved: 0, error: 'O usuário não pediu explicitamente para salvar uma memória.' };
    }
    const forbidden = /(senha|password|token|cvv|código de segurança|numero do cartão|número do cartão|chave privada)/i;
    const items = (args.items || []).map(x => String(x).trim().slice(0, 180)).filter(x => x.length >= 2 && !forbidden.test(x)).slice(0, 10);
    const existing = Array.isArray(profile.allofyMemory) ? profile.allofyMemory : [];
    const merged = [...new Set([...existing, ...items])].slice(-30);
    await database().collection('users').doc(uid).set({ allofyMemory: merged }, { merge: true });
    profile.allofyMemory = merged;
    return { saved: items.length, items: merged };
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

module.exports = { tools, executeAllofyTool, summarizeTransactions, periodRange, cleanTransaction, asNumber };
