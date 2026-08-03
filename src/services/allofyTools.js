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


function currentMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find(x => x.type === 'year')?.value;
  const month = parts.find(x => x.type === 'month')?.value;
  return `${year}-${month}`;
}

function normalizeIsoDate(value) {
  if (!value) return '';
  if (value?.toDate) value = value.toDate();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function getManualInvoice(card, month) {
  const entry = card?.invoiceOverrides?.[month];
  const raw = entry && typeof entry === 'object' ? entry.amount : entry;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = asNumber(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function calculateRegisteredCardPurchases(card, cardTransactions, month) {
  let total = 0;
  const cardId = String(card?.id || '');
  for (const purchase of Array.isArray(cardTransactions) ? cardTransactions : []) {
    const purchaseCardId = String(purchase?.cardId || purchase?.cartaoId || '');
    if (!cardId || purchaseCardId !== cardId) continue;

    const iso = normalizeIsoDate(purchase?.dataCompra || purchase?.date || purchase?.data);
    if (!iso) continue;
    const [year, monthNumber, day] = iso.split('-').map(Number);
    const installments = Math.max(1, Math.trunc(asNumber(purchase?.parcelas ?? purchase?.installments ?? 1)) || 1);
    const customInstallment = asNumber(purchase?.valorParcela ?? purchase?.installmentValue);
    const totalValue = asNumber(purchase?.valorTotal ?? purchase?.amount ?? purchase?.valor ?? purchase?.total);
    const installmentValue = customInstallment > 0 ? customInstallment : totalValue / installments;
    if (!Number.isFinite(installmentValue) || installmentValue <= 0) continue;

    const closingDay = Math.trunc(asNumber(card?.closing ?? card?.closingDay ?? card?.fechamento));
    const closingOffset = closingDay > 0 && day >= closingDay ? 1 : 0;
    for (let index = 0; index < installments; index += 1) {
      const installmentDate = new Date(year, monthNumber - 1 + closingOffset + index, 1);
      const installmentMonth = `${installmentDate.getFullYear()}-${String(installmentDate.getMonth() + 1).padStart(2, '0')}`;
      if (installmentMonth === month) total += installmentValue;
    }
  }
  return Number(total.toFixed(2));
}

function buildAccountsAndCards(profile = {}, now = new Date()) {
  const month = currentMonthKey(now);
  const cardTransactions = Array.isArray(profile.cardTransactions) ? profile.cardTransactions : [];

  const cards = (Array.isArray(profile.cards) ? profile.cards : []).slice(0, 30).map(card => {
    const manualInvoice = getManualInvoice(card, month);
    const registeredPurchases = calculateRegisteredCardPurchases(card, cardTransactions, month);
    const legacyInvoice = asNumber(card?.invoice ?? card?.fatura ?? card?.currentInvoice);

    let invoiceTotal;
    let invoiceSource;
    if (manualInvoice !== null) {
      invoiceTotal = manualInvoice;
      invoiceSource = 'manual';
    } else if (legacyInvoice > 0) {
      invoiceTotal = legacyInvoice;
      invoiceSource = 'legacy_manual';
    } else {
      invoiceTotal = registeredPurchases;
      invoiceSource = 'calculated';
    }

    const paymentEntry = card?.invoicePayments?.[month];
    const paid = Math.min(invoiceTotal, Math.max(0, asNumber(paymentEntry?.paid)));
    const invoiceOpen = Math.max(0, Number((invoiceTotal - paid).toFixed(2)));
    const debtBalance = Math.max(0, asNumber(card?.debtBalance));
    const totalOpen = Number((invoiceOpen + debtBalance).toFixed(2));
    const limit = asNumber(card?.limit ?? card?.limite);

    return {
      name: card?.name || card?.nome || 'Cartão',
      month,
      invoice: invoiceOpen,
      invoiceTotal,
      paid,
      debtBalance,
      totalOpen,
      invoiceSource,
      manualInvoice,
      registeredPurchases,
      limit,
      availableLimit: Math.max(0, Number((limit - totalOpen).toFixed(2))),
      used: asNumber(card?.used ?? card?.utilizado),
      closingDay: card?.closing ?? card?.closingDay ?? card?.fechamento ?? null,
      dueDay: card?.due ?? card?.dueDay ?? card?.vencimento ?? null,
    };
  });

  return {
    month,
    banks: (Array.isArray(profile.banks) ? profile.banks : []).slice(0, 30).map(x => ({
      name: x.name || x.nome || x.bankName || 'Conta',
      balance: asNumber(x.balance ?? x.saldo),
      type: x.type || x.tipo || '',
    })),
    cards,
    totalInvoicesOpen: Number(cards.reduce((sum, card) => sum + card.totalOpen, 0).toFixed(2)),
    benefits: (Array.isArray(profile.benefits) ? profile.benefits : []).slice(0, 20).map(x => ({
      name: x.name || x.nome || 'Benefício',
      balance: asNumber(x.balance ?? x.saldo),
    })),
  };
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
    description: 'Consulta contas bancárias, cartões, faturas atuais (inclusive valores informados manualmente), pagamentos, limites e benefícios cadastrados.',
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
  if (name === 'get_accounts_and_cards') return buildAccountsAndCards(profile);
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

module.exports = { tools, executeAllofyTool, summarizeTransactions, periodRange, cleanTransaction, asNumber, currentMonthKey, calculateRegisteredCardPurchases, buildAccountsAndCards };
