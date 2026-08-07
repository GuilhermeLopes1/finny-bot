const { hydrateProfile } = require('./v39ProfileService');
const PERIODS = [
  'today', 'yesterday', 'last_7_days', 'last_30_days',
  'month', 'last_month', 'quarter', 'year', 'all', 'custom',
];

function database() {
  return require('../config/firebase').getDb();
}

function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const normalized = value
    .replace(/R\$|\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function safeText(value, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

function dateKeyFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseBrazilianDate(text) {
  const match = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateValue(raw) {
  if (!raw) return null;
  if (raw?.toDate && typeof raw.toDate === 'function') {
    const date = raw.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number') {
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(raw).trim();
  if (!text) return null;
  const br = parseBrazilianDate(text);
  if (br) return br;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function transactionDate(item) {
  const raw = item?.date
    ?? item?.data
    ?? item?.dataCompra
    ?? item?.transactionDate
    ?? item?.createdAt
    ?? item?.timestamp
    ?? item?.updatedAt;
  return parseDateValue(raw);
}

function transactionDateKey(item) {
  const direct = item?.date ?? item?.data ?? item?.dataCompra ?? item?.transactionDate;
  if (typeof direct === 'string') {
    const iso = direct.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = direct.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) return `${br[3]}-${String(br[2]).padStart(2, '0')}-${String(br[1]).padStart(2, '0')}`;
  }
  return dateKeyFromDate(transactionDate(item));
}

function addCalendarDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function saoPauloCalendarDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Number(value.year), Number(value.month) - 1, Number(value.day), 12, 0, 0, 0);
}

function periodRange(period = 'month', now = new Date(), options = {}) {
  if (!PERIODS.includes(period)) period = 'month';
  const today = saoPauloCalendarDate(now);

  if (period === 'all') return { start: null, end: null, startKey: null, endKey: null };
  if (period === 'custom') {
    const start = parseDateValue(options.startDate);
    const end = parseDateValue(options.endDate);
    return {
      start,
      end: end ? addCalendarDays(end, 1) : null,
      startKey: start ? dateKeyFromDate(start) : null,
      endKey: end ? dateKeyFromDate(end) : null,
    };
  }

  let start;
  let end;
  if (period === 'today') {
    start = today;
    end = addCalendarDays(today, 1);
  } else if (period === 'yesterday') {
    start = addCalendarDays(today, -1);
    end = today;
  } else if (period === 'last_7_days') {
    start = addCalendarDays(today, -6);
    end = addCalendarDays(today, 1);
  } else if (period === 'last_30_days') {
    start = addCalendarDays(today, -29);
    end = addCalendarDays(today, 1);
  } else if (period === 'last_month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12);
    end = new Date(today.getFullYear(), today.getMonth(), 1, 12);
  } else if (period === 'quarter') {
    start = new Date(today.getFullYear(), today.getMonth() - 2, 1, 12);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 1, 12);
  } else if (period === 'year') {
    start = new Date(today.getFullYear(), 0, 1, 12);
    end = new Date(today.getFullYear() + 1, 0, 1, 12);
  } else {
    start = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 1, 12);
  }

  return {
    start,
    end,
    startKey: dateKeyFromDate(start),
    endKey: dateKeyFromDate(addCalendarDays(end, -1)),
  };
}

function inPeriod(item, period, now = new Date(), options = {}) {
  const range = periodRange(period, now, options);
  if (!range.start) return true;
  const key = transactionDateKey(item);
  if (!key) return false;
  if (range.startKey && key < range.startKey) return false;
  if (range.endKey && key > range.endKey) return false;
  return true;
}

function normalizeType(item) {
  const type = normalizeText(item?.type ?? item?.tipo);
  if (['income', 'receita', 'entrada', 'credit', 'credito'].includes(type)) return 'income';
  if (['expense', 'despesa', 'saida', 'debit', 'debito'].includes(type)) return 'expense';
  return asNumber(item?.amount ?? item?.value ?? item?.valor) < 0 ? 'expense' : 'unknown';
}

function normalizeStatus(item) {
  const raw = normalizeText(item?.status ?? item?.situacao ?? item?.state ?? (item?.pending ? 'pending' : 'paid'));
  if (['pending', 'pendente', 'aguardando', 'scheduled', 'agendado', 'agendada', 'open', 'aberto', 'em aberto', 'overdue', 'vencido', 'vencida'].includes(raw)) return 'pending';
  if (['cancelled', 'canceled', 'cancelado', 'cancelada', 'deleted', 'excluido', 'excluida'].includes(raw)) return 'cancelled';
  if (['partial', 'parcial'].includes(raw)) return 'partial';
  if (['paid', 'pago', 'paga', 'confirmed', 'confirmado', 'confirmada', 'completed', 'concluido', 'concluida'].includes(raw)) return 'paid';
  return raw || 'paid';
}

function amountOf(item) {
  return Math.abs(asNumber(item?.amount ?? item?.value ?? item?.valor ?? item?.valorTotal ?? item?.total));
}

function cleanTransaction(item) {
  return {
    description: safeText(item?.description || item?.desc || item?.name || item?.nome || item?.descricao || 'Sem descrição', 160),
    amount: amountOf(item),
    type: normalizeType(item),
    category: safeText(item?.category || item?.categoria || 'Outros', 80),
    date: transactionDateKey(item) || null,
    status: normalizeStatus(item),
    account: safeText(item?.bankName || item?.bank || item?.conta || item?.account || '', 100),
  };
}

function bankInstitutionName(bank = {}) {
  return safeText(bank.institution || bank.bankName || bank.name || bank.nome || 'Conta', 100);
}

function bankDisplayName(bank = {}) {
  return safeText(bank.accountName || bank.nickname || bank.apelido || bank.name || bank.nome || bankInstitutionName(bank) || 'Conta', 100);
}

function buildLookup(profile = {}) {
  const categories = new Map();
  const categoriesByName = new Map();
  for (const category of Array.isArray(profile.categories) ? profile.categories : []) {
    const id = safeText(category?.id, 120);
    const value = {
      id,
      name: safeText(category?.name || category?.nome || 'Outros', 100),
      emoji: safeText(category?.emoji || '🏷️', 8),
      limit: asNumber(category?.limit ?? category?.limite),
      type: safeText(category?.type || category?.tipo, 30),
    };
    if (id) categories.set(id, value);
    categoriesByName.set(normalizeText(value.name), value);
  }

  const banks = new Map();
  const bankSearch = [];
  for (const bank of Array.isArray(profile.banks) ? profile.banks : []) {
    const id = safeText(bank?.id, 120);
    const sourceName = safeText(bank?.name || bank?.nome, 100) || null;
    const sourceInstitution = safeText(bank?.institution || bank?.instituicao || bank?.bankName, 100) || null;
    const sourceAccountName = safeText(bank?.accountName || bank?.nickname || bank?.apelido || bank?.label, 100) || null;
    const ownerHint = safeText(
      bank?.owner || bank?.ownerName || bank?.titular || bank?.holder || bank?.responsavel || bank?.responsável,
      80,
    ) || null;
    const value = {
      id,
      name: bankDisplayName(bank),
      institution: bankInstitutionName(bank),
      type: safeText(bank?.type || bank?.tipo || 'corrente', 50),
      balance: asNumber(bank?.balance ?? bank?.saldo),
      sourceName,
      sourceInstitution,
      sourceAccountName,
      ownerHint,
      createdAt: safeText(bank?.createdAt, 50) || null,
      updatedAt: safeText(bank?.updatedAt, 50) || null,
      lastReconciledAt: safeText(bank?.lastReconciledAt, 50) || null,
    };
    if (id) banks.set(id, value);
    bankSearch.push(value);
  }

  const cards = new Map();
  const cardSearch = [];
  for (const card of Array.isArray(profile.cards) ? profile.cards : []) {
    const id = safeText(card?.id, 120);
    const value = {
      id,
      name: safeText(card?.name || card?.nome || 'Cartão', 100),
      brand: safeText(card?.brand || card?.bandeira, 40),
      last4: safeText(card?.last4 || card?.final, 4),
      limit: asNumber(card?.limit ?? card?.limite),
      closingDay: card?.closing ?? card?.closingDay ?? card?.fechamento ?? null,
      dueDay: card?.due ?? card?.dueDay ?? card?.vencimento ?? null,
    };
    if (id) cards.set(id, value);
    cardSearch.push(value);
  }

  const benefits = new Map();
  for (const benefit of Array.isArray(profile.benefits) ? profile.benefits : []) {
    const id = safeText(benefit?.id, 120);
    const transactions = Array.isArray(benefit?.transactions) ? benefit.transactions : [];
    const used = transactions.reduce((sum, tx) => sum + amountOf(tx), 0);
    const value = {
      id,
      name: safeText(benefit?.name || benefit?.nome || 'Benefício', 100),
      emoji: safeText(benefit?.emoji || '🎁', 8),
      total: asNumber(benefit?.total),
      used,
      remaining: Math.max(0, asNumber(benefit?.total) - used),
    };
    if (id) benefits.set(id, value);
  }

  const vehicles = new Map();
  for (const vehicle of Array.isArray(profile.uberVeiculos) ? profile.uberVeiculos : []) {
    const id = safeText(vehicle?.id, 120);
    if (id) vehicles.set(id, {
      id,
      name: safeText(vehicle?.modelo || vehicle?.name || vehicle?.placa || 'Veículo', 100),
      plate: safeText(vehicle?.placa, 20),
      type: safeText(vehicle?.tipo, 30),
      fuel: safeText(vehicle?.combustivel, 30),
      average: asNumber(vehicle?.media),
    });
  }

  return { categories, categoriesByName, banks, bankSearch, cards, cardSearch, benefits, vehicles };
}

function resolveCategory(raw, lookup) {
  const key = safeText(raw, 120);
  if (key && lookup?.categories?.has(key)) return lookup.categories.get(key);
  const byName = lookup?.categoriesByName?.get(normalizeText(key));
  if (byName) return byName;
  return { id: key || null, name: key || 'Outros', emoji: '🏷️', limit: 0, type: '' };
}

function matchEntity(search, entities, fields) {
  const wanted = normalizeText(search);
  if (!wanted) return null;
  return entities.find(entity => fields.some(field => normalizeText(entity?.[field]).includes(wanted))) || null;
}

function resolveBank(item, lookup) {
  const id = safeText(item?.bankId || item?.accountId || item?.contaId || item?.originId, 120);
  if (id && lookup?.banks?.has(id)) return lookup.banks.get(id);
  const rawName = item?.bankName || item?.bank || item?.conta || item?.account || item?.accountName;
  const wanted = normalizeText(rawName);
  if (!wanted) return null;
  const banks = lookup?.bankSearch || [];
  const exactName = banks.filter(bank => normalizeText(bank.name) === wanted || normalizeText(bank.sourceAccountName) === wanted);
  if (exactName.length === 1) return exactName[0];
  const exactInstitution = banks.filter(bank => normalizeText(bank.institution) === wanted || normalizeText(bank.sourceInstitution) === wanted);
  if (exactInstitution.length === 1) return exactInstitution[0];
  const partial = banks.filter(bank => [bank.name, bank.sourceAccountName, bank.institution]
    .some(value => normalizeText(value).includes(wanted)));
  return partial.length === 1 ? partial[0] : null;
}

function resolveCard(item, lookup) {
  const id = safeText(item?.cardId || item?.cartaoId || item?.originId, 120);
  if (id && lookup?.cards?.has(id)) return lookup.cards.get(id);
  const rawName = item?.cardName || item?.cartao || item?.card;
  return matchEntity(rawName, lookup?.cardSearch || [], ['name', 'brand', 'last4']) || null;
}

function resolveBenefit(item, lookup) {
  const id = safeText(item?.benefitId || item?.beneficioId || item?.originId, 120);
  return id && lookup?.benefits?.has(id) ? lookup.benefits.get(id) : null;
}

function detectSource(item, bank, card, benefit, sourceHint = '') {
  if (sourceHint) return sourceHint;
  if (item?.isUber) return 'driver';
  if (benefit || item?.coveredByBenefit) return 'benefit';
  if (card) return 'card';
  const raw = normalizeText(item?.source || item?.origem);
  if (raw.includes('whatsapp')) return 'whatsapp';
  if (raw.includes('import')) return 'import';
  if (bank) return 'bank';
  return raw || 'manual';
}

function normalizePrimaryTransaction(item, lookup) {
  const category = resolveCategory(item?.category ?? item?.categoria, lookup);
  const bank = resolveBank(item, lookup);
  const card = resolveCard(item, lookup);
  const benefit = resolveBenefit(item, lookup);
  const description = safeText(item?.description || item?.desc || item?.descricao || item?.name || item?.nome || 'Sem descrição', 180);
  const status = normalizeStatus(item);
  const type = normalizeType(item);
  const amount = amountOf(item);
  const isTransfer = item?.isTransfer === true || normalizeText(item?.notes).includes('transferencia entre contas');
  const isInvoicePayment = /pagamento\s+(de\s+)?fatura/i.test(description);
  const coveredByBenefit = item?.coveredByBenefit === true || Boolean(benefit);
  const source = detectSource(item, bank, card, benefit);
  return {
    id: safeText(item?.id, 160) || null,
    kind: 'transaction',
    description,
    amount,
    type,
    date: transactionDateKey(item) || null,
    status,
    category,
    account: bank,
    accountId: bank?.id || safeText(item?.bankId || item?.accountId || item?.contaId, 120) || null,
    card,
    cardId: card?.id || safeText(item?.cardId || item?.cartaoId, 120) || null,
    benefit,
    benefitId: benefit?.id || safeText(item?.benefitId || item?.beneficioId, 120) || null,
    recurrence: safeText(item?.recurrence || item?.recorrencia || 'variable', 30),
    notes: safeText(item?.notes || item?.obs || item?.observacao, 500) || null,
    source,
    isTransfer,
    transferGroupId: safeText(item?.transferGroupId, 160) || null,
    debtId: safeText(item?.debtId || item?.dividaId, 120) || null,
    coveredByBenefit,
    isInvoicePayment,
    createdAt: safeText(item?.createdAt, 60) || null,
    updatedAt: safeText(item?.updatedAt, 60) || null,
    countsAsSpending: type === 'expense' && status === 'paid' && !isTransfer && !coveredByBenefit && !isInvoicePayment,
    countsAsIncome: type === 'income' && status === 'paid' && !isTransfer,
  };
}

function normalizeCardPurchase(item, lookup) {
  const card = resolveCard(item, lookup);
  const category = resolveCategory(item?.categoria ?? item?.category, lookup);
  const installments = Math.max(1, Math.trunc(asNumber(item?.parcelas ?? item?.installments ?? 1)) || 1);
  const total = amountOf({ amount: item?.valorTotal ?? item?.amount ?? item?.valor ?? item?.total });
  const customInstallment = asNumber(item?.valorParcela ?? item?.installmentValue);
  const installmentValue = customInstallment > 0 ? customInstallment : (installments ? total / installments : total);
  return {
    id: safeText(item?.id, 160) || null,
    kind: 'card_purchase',
    description: safeText(item?.descricao || item?.description || item?.desc || 'Compra no cartão', 180),
    amount: total,
    type: 'expense',
    date: transactionDateKey(item) || null,
    status: normalizeStatus(item),
    category,
    account: null,
    accountId: null,
    card,
    cardId: card?.id || safeText(item?.cardId || item?.cartaoId, 120) || null,
    benefit: null,
    benefitId: null,
    recurrence: installments > 1 ? 'installment' : 'variable',
    notes: safeText(item?.obs || item?.notes || item?.observacao, 500) || null,
    source: 'card',
    isTransfer: false,
    transferGroupId: null,
    coveredByBenefit: false,
    isInvoicePayment: false,
    createdAt: safeText(item?.createdAt, 60) || null,
    updatedAt: safeText(item?.updatedAt, 60) || null,
    installments,
    installmentValue: Number(installmentValue.toFixed(2)),
    hasInterest: item?.temJuros === true || item?.hasInterest === true,
    countsAsSpending: normalizeStatus(item) === 'paid',
    countsAsIncome: false,
  };
}

function recordSignature(record) {
  return [
    normalizeText(record.description),
    Number(record.amount || 0).toFixed(2),
    record.date || '',
    record.cardId || '',
  ].join('|');
}

function collectTransactions(profile = {}) {
  const lookup = buildLookup(profile);
  const primary = (Array.isArray(profile.transactions) ? profile.transactions : []).map(item => normalizePrimaryTransaction(item, lookup));
  const cardPurchases = (Array.isArray(profile.cardTransactions) ? profile.cardTransactions : []).map(item => normalizeCardPurchase(item, lookup));

  // Algumas versões antigas gravavam a mesma compra nas duas coleções.
  // Quando há uma compra detalhada em cardTransactions, ela prevalece.
  const cardSignatures = new Set(cardPurchases.map(recordSignature));
  const dedupedPrimary = primary.filter(record => !(record.cardId && cardSignatures.has(recordSignature(record))));
  return { lookup, items: [...dedupedPrimary, ...cardPurchases] };
}

function publicRecord(record, lookup = null) {
  return {
    id: record.id,
    kind: record.kind,
    description: record.description,
    amount: record.amount,
    type: record.type,
    date: record.date,
    status: record.status,
    category: record.category,
    account: record.account,
    accountId: record.accountId,
    card: record.card,
    cardId: record.cardId,
    benefit: record.benefit,
    benefitId: record.benefitId,
    recurrence: record.recurrence,
    notes: record.notes,
    source: record.source,
    isTransfer: record.isTransfer,
    transferGroupId: record.transferGroupId,
    debtId: record.debtId || null,
    coveredByBenefit: record.coveredByBenefit,
    isInvoicePayment: record.isInvoicePayment,
    installments: record.installments || null,
    installmentValue: record.installmentValue || null,
    hasInterest: record.hasInterest || false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    owner: lookup ? fallbackOwnerForRecord(record, lookup) : null,
  };
}

function recordMatchesPeriod(record, args = {}, now = new Date()) {
  if (args.exactDate && record.date !== args.exactDate) return false;
  return inPeriod(record, args.period || 'month', now, { startDate: args.startDate, endDate: args.endDate });
}

function summarizeTransactions(items, period = 'month', now = new Date(), options = {}) {
  const rawItems = Array.isArray(items) ? items : [];
  const normalized = rawItems.map(item => ({
    type: normalizeType(item),
    amount: amountOf(item),
    date: transactionDateKey(item),
    status: normalizeStatus(item),
    category: safeText(item?.category || item?.categoria || 'Outros', 80),
    isTransfer: item?.isTransfer === true,
    coveredByBenefit: item?.coveredByBenefit === true || Boolean(item?.benefitId),
    description: safeText(item?.description || item?.desc || item?.descricao, 160),
  })).filter(item => inPeriod(item, period, now, options));

  const summary = {
    period,
    income: 0,
    expenses: 0,
    balance: 0,
    count: normalized.length,
    paidCount: 0,
    pending: 0,
    pendingIncome: 0,
    pendingExpenses: 0,
    byCategory: {},
  };

  for (const item of normalized) {
    if (item.status === 'pending') {
      summary.pending += item.amount;
      if (item.type === 'income') summary.pendingIncome += item.amount;
      if (item.type === 'expense') summary.pendingExpenses += item.amount;
      continue;
    }
    if (item.status === 'cancelled' || item.isTransfer || item.coveredByBenefit) continue;
    const invoicePayment = /pagamento\s+(de\s+)?fatura/i.test(item.description);
    if (item.type === 'income') {
      summary.income += item.amount;
      summary.paidCount += 1;
    }
    if (item.type === 'expense' && !invoicePayment) {
      summary.expenses += item.amount;
      summary.paidCount += 1;
      summary.byCategory[item.category] = (summary.byCategory[item.category] || 0) + item.amount;
    }
  }
  summary.balance = summary.income - summary.expenses;
  summary.byCategory = Object.fromEntries(Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 20));
  return summary;
}

function currentMonthKey(now = new Date()) {
  const local = saoPauloCalendarDate(now);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeIsoDate(value) {
  return transactionDateKey({ date: value });
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
  const lookup = buildLookup(profile);
  const cardTransactions = Array.isArray(profile.cardTransactions) ? profile.cardTransactions : [];

  const cards = (Array.isArray(profile.cards) ? profile.cards : []).slice(0, 50).map(card => {
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
    const basic = lookup.cards.get(String(card?.id || ''));

    return {
      ...basic,
      month,
      invoice: invoiceOpen,
      invoiceTotal,
      paid,
      debtBalance,
      totalOpen,
      invoiceSource,
      manualInvoice,
      registeredPurchases,
      availableLimit: Math.max(0, Number((limit - totalOpen).toFixed(2))),
      used: asNumber(card?.used ?? card?.utilizado),
      purchaseCount: cardTransactions.filter(item => String(item?.cardId || item?.cartaoId || '') === String(card?.id || '')).length,
    };
  });

  return {
    month,
    banks: [...lookup.banks.values()].slice(0, 50),
    totalBankBalance: Number([...lookup.banks.values()].reduce((sum, bank) => sum + bank.balance, 0).toFixed(2)),
    cards,
    totalInvoicesOpen: Number(cards.reduce((sum, card) => sum + card.totalOpen, 0).toFixed(2)),
    benefits: [...lookup.benefits.values()].slice(0, 30),
  };
}

function aggregate(records, selector) {
  const map = new Map();
  for (const record of records) {
    const selected = selector(record);
    if (!selected?.key) continue;
    const current = map.get(selected.key) || { ...selected, total: 0, count: 0 };
    current.total += record.amount;
    current.count += 1;
    map.set(selected.key, current);
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20);
}


function financialRecordIsRelevant(record) {
  return !record.isTransfer && !record.coveredByBenefit && !record.isInvoicePayment
    && (record.type === 'income' || record.type === 'expense');
}

function accountDescriptor(record) {
  if (record.account) {
    return {
      key: record.account.id || normalizeText(`${record.account.name} ${record.account.institution}`) || 'conta',
      id: record.account.id || null,
      name: record.account.name || record.account.institution || 'Conta',
      institution: record.account.institution || null,
      type: record.account.type || null,
      unassigned: false,
    };
  }
  if (record.card) {
    return {
      key: `card:${record.card.id || normalizeText(record.card.name) || 'cartao'}`,
      id: null,
      name: record.card.name ? `Cartão ${record.card.name}` : 'Compra no cartão',
      institution: record.card.brand || null,
      type: 'card',
      unassigned: true,
    };
  }
  return {
    key: '__sem_conta__',
    id: null,
    name: 'Sem conta vinculada',
    institution: null,
    type: null,
    unassigned: true,
  };
}

function buildAccountBreakdown(records) {
  const buckets = new Map();
  for (const record of records) {
    if (!financialRecordIsRelevant(record)) continue;
    const descriptor = accountDescriptor(record);
    const bucket = buckets.get(descriptor.key) || {
      ...descriptor,
      paidIncome: 0,
      paidExpenses: 0,
      realizedBalance: 0,
      pendingIncome: 0,
      pendingExpenses: 0,
      partialIncome: 0,
      partialExpenses: 0,
      totalRecords: 0,
      paidRecords: 0,
      pendingRecords: 0,
      partialRecords: 0,
    };
    bucket.totalRecords += 1;
    if (record.status === 'paid') {
      if (record.type === 'income') bucket.paidIncome += record.amount;
      if (record.type === 'expense') bucket.paidExpenses += record.amount;
      bucket.paidRecords += 1;
    } else if (record.status === 'pending') {
      if (record.type === 'income') bucket.pendingIncome += record.amount;
      if (record.type === 'expense') bucket.pendingExpenses += record.amount;
      bucket.pendingRecords += 1;
    } else if (record.status === 'partial') {
      if (record.type === 'income') bucket.partialIncome += record.amount;
      if (record.type === 'expense') bucket.partialExpenses += record.amount;
      bucket.partialRecords += 1;
    }
    bucket.realizedBalance = bucket.paidIncome - bucket.paidExpenses;
    buckets.set(descriptor.key, bucket);
  }

  return [...buckets.values()]
    .map(bucket => ({
      ...bucket,
      paidIncome: Number(bucket.paidIncome.toFixed(2)),
      paidExpenses: Number(bucket.paidExpenses.toFixed(2)),
      realizedBalance: Number(bucket.realizedBalance.toFixed(2)),
      pendingIncome: Number(bucket.pendingIncome.toFixed(2)),
      pendingExpenses: Number(bucket.pendingExpenses.toFixed(2)),
      partialIncome: Number(bucket.partialIncome.toFixed(2)),
      partialExpenses: Number(bucket.partialExpenses.toFixed(2)),
    }))
    .sort((a, b) => {
      const totalA = a.paidIncome + a.paidExpenses + a.pendingIncome + a.pendingExpenses;
      const totalB = b.paidIncome + b.paidExpenses + b.pendingIncome + b.pendingExpenses;
      return totalB - totalA;
    })
    .slice(0, 30);
}

function compactFinancialRecord(record) {
  return {
    id: record.id,
    description: record.description,
    amount: record.amount,
    type: record.type,
    date: record.date,
    status: record.status,
    category: record.category ? {
      id: record.category.id || null,
      name: record.category.name || 'Outros',
      emoji: record.category.emoji || '🏷️',
    } : null,
    account: record.account ? {
      id: record.account.id || null,
      name: record.account.name || record.account.institution || 'Conta',
      institution: record.account.institution || null,
      type: record.account.type || null,
    } : null,
    card: record.card ? {
      id: record.card.id || null,
      name: record.card.name || 'Cartão',
      brand: record.card.brand || null,
      last4: record.card.last4 || null,
    } : null,
  };
}

function sortPendingRecords(records) {
  return [...records].sort((a, b) => {
    const dateCompare = String(a.date || '9999-12-31').localeCompare(String(b.date || '9999-12-31'));
    if (dateCompare !== 0) return dateCompare;
    return b.amount - a.amount;
  });
}


const OWNER_STOPWORDS = new Set([
  'banco', 'bank', 'conta', 'corrente', 'poupanca', 'poupança', 'carteira', 'digital',
  'cartao', 'cartão', 'credito', 'crédito', 'visa', 'mastercard', 'elo', 'amex',
  'nubank', 'inter', 'caixa', 'bradesco', 'itau', 'itaú', 'santander', 'c6',
  'principal', 'reserva', 'investimentos', 'investimento', 'platinum', 'gold', 'black',
]);

const OWNER_ALIAS_GROUPS = [
  { key: 'owner:gui', label: 'Gui', aliases: ['gui', 'guilherme'] },
  { key: 'owner:luh', label: 'Luh', aliases: ['luh', 'ludmilla', 'ludmila'] },
];

function wordsOf(value) {
  return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function canonicalOwnerAlias(token) {
  const normalized = normalizeText(token);
  return OWNER_ALIAS_GROUPS.find(group => group.aliases.includes(normalized)) || null;
}

function entityText(entity = {}) {
  return normalizeText([
    entity.name, entity.nome, entity.accountName, entity.nickname, entity.apelido,
    entity.institution, entity.instituicao, entity.bankName, entity.bank,
    entity.creditor, entity.credor, entity.description, entity.descricao,
    entity.owner, entity.ownerName, entity.titular, entity.holder, entity.responsavel, entity.responsável,
    entity.notes, entity.obs, entity.observacao,
    entity.account?.name, entity.account?.institution,
    entity.card?.name, entity.card?.brand,
  ].filter(Boolean).join(' '));
}

function meaningfulOwnerTokens(bank = {}) {
  const explicitInstitution = bank.sourceInstitution || (
    normalizeText(bank.institution) !== normalizeText(bank.name) ? bank.institution : ''
  );
  const institutionTokens = new Set(wordsOf(explicitInstitution));
  const candidates = [
    bank.ownerHint,
    bank.sourceAccountName,
    bank.sourceName,
    bank.name,
  ].filter(Boolean);
  const tokens = [];
  for (const candidate of candidates) {
    for (const token of wordsOf(candidate)) {
      if (token.length < 2 || OWNER_STOPWORDS.has(token)) continue;
      if (institutionTokens.has(token)) continue;
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens;
}

function inferAccountForEntity(entity = {}, lookup, relatedPayments = []) {
  const explicit = resolveBank(entity, lookup);
  if (explicit) return explicit;

  for (const payment of [...relatedPayments].reverse()) {
    const paymentBank = payment?.account || resolveBank(payment, lookup);
    if (paymentBank) return paymentBank;
  }

  const haystack = entityText(entity);
  if (!haystack) return null;
  let best = null;
  let bestScore = 0;
  for (const bank of lookup?.bankSearch || []) {
    let score = 0;
    const bankName = normalizeText(bank.name);
    const institution = normalizeText(bank.institution);
    if (bankName && haystack.includes(bankName)) score += 50 + bankName.length;
    if (institution && haystack.includes(institution)) score += 8;
    for (const token of meaningfulOwnerTokens(bank)) {
      if (haystack.split(/[^a-z0-9]+/).includes(token)) score += 30 + token.length;
    }
    if (score > bestScore) {
      best = bank;
      bestScore = score;
    }
  }
  return bestScore >= 20 ? best : null;
}

function accountSummaryDescriptor(account) {
  if (!account) return {
    key: '__sem_conta__', id: null, name: 'Sem conta vinculada', institution: null, unassigned: true,
  };
  return {
    key: account.id || normalizeText(`${account.name} ${account.institution}`) || '__sem_conta__',
    id: account.id || null,
    name: account.name || account.institution || 'Conta',
    institution: account.institution || null,
    unassigned: false,
  };
}

function monthDueDate(month, dueDay) {
  if (!month || !dueDay) return null;
  const [year, monthNumber] = String(month).split('-').map(Number);
  if (!year || !monthNumber) return null;
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const day = Math.min(Math.max(1, Math.trunc(asNumber(dueDay))), lastDay);
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}


function titleCaseOwner(value) {
  const raw = safeText(value, 80);
  if (!raw) return null;
  return raw.split(/\s+/).map(part => part ? part[0].toLocaleUpperCase('pt-BR') + part.slice(1).toLocaleLowerCase('pt-BR') : '').join(' ');
}

function ownerTokensFromBank(bank = {}) {
  return meaningfulOwnerTokens(bank).filter(token => token.length >= 2);
}

function ownerCatalog(lookup) {
  const map = new Map();
  for (const bank of lookup?.bankSearch || []) {
    const tokens = ownerTokensFromBank(bank);
    for (const token of tokens) {
      const aliasGroup = canonicalOwnerAlias(token);
      const key = aliasGroup?.key || `owner:${token}`;
      const current = map.get(key) || {
        key,
        label: aliasGroup?.label || titleCaseOwner(token),
        tokens: new Set(aliasGroup?.aliases || []),
        accounts: [],
      };
      current.tokens.add(token);
      if (!current.accounts.some(account => account.id === bank.id)) current.accounts.push(bank);
      map.set(key, current);
    }
  }
  return [...map.values()].map(owner => ({ ...owner, tokens: [...owner.tokens] }));
}

function ownerForAccount(account, lookup) {
  if (!account) return null;
  const tokens = ownerTokensFromBank(account);
  if (!tokens.length) return null;
  const catalog = ownerCatalog(lookup);
  for (const token of tokens) {
    const aliasGroup = canonicalOwnerAlias(token);
    const catalogMatch = catalog.find(owner => owner.key === aliasGroup?.key || owner.tokens.includes(token));
    if (catalogMatch) return catalogMatch;
    if (aliasGroup) return { ...aliasGroup, tokens: [...aliasGroup.aliases], accounts: [account] };
  }
  const token = tokens[0];
  return { key: `owner:${token}`, label: titleCaseOwner(token), tokens: [token], accounts: [account] };
}

function inferOwnerForEntity(entity = {}, lookup, explicitAccount = null) {
  const fromAccount = ownerForAccount(explicitAccount, lookup);
  if (fromAccount) return { ...fromAccount, confidence: 'high', source: 'account' };

  const haystack = entityText(entity);
  if (!haystack) return null;
  const words = new Set(wordsOf(haystack));
  let best = null;
  let bestScore = 0;
  for (const owner of ownerCatalog(lookup)) {
    let score = 0;
    for (const token of owner.tokens) {
      if (words.has(token)) {
        score += 70 + token.length;
      } else if (token.length >= 4 && haystack.includes(token)) {
        score += 25 + token.length;
      }
    }
    if (score > bestScore) { best = owner; bestScore = score; }
  }
  if (!best || bestScore < 30) return null;
  return { ...best, confidence: bestScore >= 70 ? 'high' : 'medium', source: 'name' };
}

function ownerDescriptor(owner) {
  if (!owner) return { key: '__sem_proprietario__', label: 'Sem vínculo identificado', unassigned: true };
  return { key: owner.key, label: owner.label, unassigned: false, confidence: owner.confidence || null, source: owner.source || null };
}

function buildAccountSnapshot(profile = {}) {
  const lookup = buildLookup(profile);
  const accounts = [...lookup.banks.values()].map(account => ({
    ...account,
    owner: ownerDescriptor(ownerForAccount(account, lookup)),
  }));
  const byOwnerMap = new Map();
  for (const account of accounts) {
    const owner = account.owner;
    const bucket = byOwnerMap.get(owner.key) || { ...owner, accounts: [], balance: 0 };
    bucket.accounts.push(account);
    bucket.balance += account.balance;
    byOwnerMap.set(owner.key, bucket);
  }
  const byOwner = [...byOwnerMap.values()].map(bucket => ({
    ...bucket,
    balance: Number(bucket.balance.toFixed(2)),
  })).sort((a, b) => b.balance - a.balance);
  return {
    accounts,
    byOwner,
    totalBalance: Number(accounts.reduce((sum, account) => sum + account.balance, 0).toFixed(2)),
  };
}

function fallbackOwnerForRecord(record, lookup) {
  const inferred = inferOwnerForEntity(record, lookup, record?.account || null);
  if (inferred) return ownerDescriptor(inferred);
  if (record?.account) {
    return {
      key: `account:${record.account.id || normalizeText(record.account.name || record.account.institution)}`,
      label: record.account.name || record.account.institution || 'Conta bancária',
      unassigned: false,
      confidence: 'high',
      source: 'account_without_owner_hint',
    };
  }
  if (record?.card) {
    return {
      key: `card:${record.card.id || normalizeText(record.card.name)}`,
      label: record.card.name || 'Cartão',
      unassigned: true,
      confidence: 'low',
      source: 'card_without_owner_hint',
    };
  }
  return ownerDescriptor(null);
}

function buildOwnerFinancialBreakdown(records, profile = {}) {
  const lookup = buildLookup(profile);
  const buckets = new Map();
  for (const record of records) {
    if (!financialRecordIsRelevant(record)) continue;
    const owner = fallbackOwnerForRecord(record, lookup);
    const bucket = buckets.get(owner.key) || {
      ...owner,
      accounts: [],
      paidIncome: 0,
      paidExpenses: 0,
      pendingIncome: 0,
      pendingExpenses: 0,
      partialIncome: 0,
      partialExpenses: 0,
      realizedBalance: 0,
      records: 0,
    };
    if (record.account && !bucket.accounts.some(account => account.id === record.account.id)) {
      bucket.accounts.push(record.account);
    }
    bucket.records += 1;
    if (record.status === 'paid') {
      if (record.type === 'income') bucket.paidIncome += record.amount;
      if (record.type === 'expense') bucket.paidExpenses += record.amount;
    } else if (record.status === 'pending') {
      if (record.type === 'income') bucket.pendingIncome += record.amount;
      if (record.type === 'expense') bucket.pendingExpenses += record.amount;
    } else if (record.status === 'partial') {
      if (record.type === 'income') bucket.partialIncome += record.amount;
      if (record.type === 'expense') bucket.partialExpenses += record.amount;
    }
    bucket.realizedBalance = bucket.paidIncome - bucket.paidExpenses;
    buckets.set(owner.key, bucket);
  }
  return [...buckets.values()].map(bucket => ({
    ...bucket,
    paidIncome: Number(bucket.paidIncome.toFixed(2)),
    paidExpenses: Number(bucket.paidExpenses.toFixed(2)),
    pendingIncome: Number(bucket.pendingIncome.toFixed(2)),
    pendingExpenses: Number(bucket.pendingExpenses.toFixed(2)),
    partialIncome: Number(bucket.partialIncome.toFixed(2)),
    partialExpenses: Number(bucket.partialExpenses.toFixed(2)),
    realizedBalance: Number(bucket.realizedBalance.toFixed(2)),
  })).sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    const total = item => item.paidIncome + item.paidExpenses + item.pendingIncome + item.pendingExpenses;
    return total(b) - total(a);
  });
}

function significantTokens(value) {
  const stop = new Set([
    ...OWNER_STOPWORDS,
    'pagamento', 'pagar', 'parcela', 'parcelas', 'fatura', 'mensal', 'mes', 'mês',
    'financiamento', 'emprestimo', 'empréstimo', 'divida', 'dívida', 'conta', 'cartao', 'cartão',
    'gui', 'luh', 'guilherme', 'ludmilla', 'ludmila',
  ]);
  return normalizeText(value).split(/[^a-z0-9]+/).filter(token => token.length >= 4 && !stop.has(token));
}

function tokenOverlap(a, b) {
  const left = new Set(significantTokens(a));
  const right = new Set(significantTokens(b));
  const common = [...left].filter(token => right.has(token));
  return { common, count: common.length };
}

function sameMoney(a, b, tolerance = 0.02) {
  return Math.abs(asNumber(a) - asNumber(b)) <= tolerance;
}

function dueStatus(date, now = new Date()) {
  const key = normalizeIsoDate(date);
  if (!key) return 'undated';
  const today = dateKeyFromDate(saoPauloCalendarDate(now));
  const plusSeven = dateKeyFromDate(addCalendarDays(saoPauloCalendarDate(now), 7));
  if (key < today) return 'overdue';
  if (key === today) return 'today';
  if (key <= plusSeven) return 'next_7_days';
  return 'later';
}

function pendingDuplicateReference(record, commitments = {}) {
  const cards = commitments.openCardInvoices || [];
  const debts = commitments.openDebts || [];

  for (const card of cards) {
    if (record.cardId && card.id && String(record.cardId) === String(card.id)) {
      return { kind: 'card_invoice', id: card.id, name: card.name, confidence: 'high' };
    }
    const overlap = tokenOverlap(`${record.description} ${record.card?.name || ''}`, card.name);
    const ownerMatches = !record.account || !card.owner || record.owner?.key === card.owner?.key || record.account?.id === card.account?.id;
    if (ownerMatches && (overlap.count >= 2 || (overlap.count >= 1 && sameMoney(record.amount, card.totalOpen)))) {
      return { kind: 'card_invoice', id: card.id, name: card.name, confidence: overlap.count >= 2 ? 'high' : 'medium' };
    }
  }

  for (const debt of debts) {
    const overlap = tokenOverlap(record.description, `${debt.name} ${debt.creditor || ''}`);
    const ownerMatches = !record.account || !debt.owner || record.owner?.key === debt.owner?.key || record.account?.id === debt.account?.id;
    if (ownerMatches && overlap.count >= 1 && (sameMoney(record.amount, debt.installmentOpen) || overlap.count >= 2)) {
      return { kind: 'debt_installment', id: debt.id, name: debt.name, confidence: overlap.count >= 2 ? 'high' : 'medium' };
    }
  }
  return null;
}

function buildCommitmentAnalysis(pendingExpenseRecords, pendingIncome, commitments, accountSnapshot, now = new Date()) {
  const classified = pendingExpenseRecords.map(record => {
    const owner = inferOwnerForEntity(record, { bankSearch: accountSnapshot.accounts }, record.account);
    const enriched = { ...record, owner };
    const duplicateOf = pendingDuplicateReference(enriched, commitments);
    return { ...compactFinancialRecord(record), owner: ownerDescriptor(owner), duplicateOf };
  });
  const directPending = classified.filter(item => !item.duplicateOf);
  const overlappedPending = classified.filter(item => item.duplicateOf);
  const directPendingExpenses = Number(directPending.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const overlappedPendingExpenses = Number(overlappedPending.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const cardInvoicesOpen = asNumber(commitments?.totals?.cardInvoicesOpen);
  const debtInstallmentsOpen = asNumber(commitments?.totals?.debtInstallmentsOpen);
  const uniqueCashOutflow = Number((directPendingExpenses + cardInvoicesOpen + debtInstallmentsOpen).toFixed(2));
  const resources = Number((accountSnapshot.totalBalance + pendingIncome).toFixed(2));
  const projectedWithoutPendingIncome = Number((accountSnapshot.totalBalance - uniqueCashOutflow).toFixed(2));
  const projectedAvailable = Number((resources - uniqueCashOutflow).toFixed(2));
  const shortfallNow = Number(Math.max(0, -projectedWithoutPendingIncome).toFixed(2));
  const shortfall = Number(Math.max(0, -projectedAvailable).toFixed(2));
  const coveragePercentNow = uniqueCashOutflow > 0 ? Number(Math.min(999, accountSnapshot.totalBalance / uniqueCashOutflow * 100).toFixed(1)) : 100;
  const coveragePercent = uniqueCashOutflow > 0 ? Number(Math.min(999, resources / uniqueCashOutflow * 100).toFixed(1)) : 100;

  const dueItems = [
    ...directPending.map(item => ({ kind: 'transaction', id: item.id, name: item.description, amount: item.amount, date: item.date, status: dueStatus(item.date, now), owner: item.owner })),
    ...(commitments.openCardInvoices || []).map(card => ({ kind: 'card_invoice', id: card.id, name: card.name, amount: card.totalOpen, date: card.dueDate, status: dueStatus(card.dueDate, now), owner: card.owner || ownerDescriptor(null) })),
    ...(commitments.openDebts || []).filter(debt => debt.installmentOpen > 0).map(debt => ({ kind: 'debt_installment', id: debt.id, name: debt.name, amount: debt.installmentOpen, date: debt.dueDate, status: dueStatus(debt.dueDate, now), owner: debt.owner || ownerDescriptor(null) })),
  ];

  return {
    directPendingItems: directPending,
    overlappedPendingItems: overlappedPending,
    directPendingExpenses,
    overlappedPendingExpenses,
    grossRegisteredCommitments: Number((pendingExpenseRecords.reduce((sum, record) => sum + record.amount, 0) + cardInvoicesOpen + debtInstallmentsOpen).toFixed(2)),
    uniqueCashOutflow,
    currentBankBalance: accountSnapshot.totalBalance,
    pendingIncome: Number(asNumber(pendingIncome).toFixed(2)),
    resources,
    projectedWithoutPendingIncome,
    projectedAvailable,
    shortfallNow,
    shortfall,
    coveragePercentNow,
    coveragePercent,
    due: {
      overdue: dueItems.filter(item => item.status === 'overdue'),
      today: dueItems.filter(item => item.status === 'today'),
      next7Days: dueItems.filter(item => item.status === 'next_7_days'),
      later: dueItems.filter(item => item.status === 'later'),
      undated: dueItems.filter(item => item.status === 'undated'),
    },
    note: overlappedPending.length
      ? `${overlappedPending.length} pendência(s) foram reconhecidas como já representadas em faturas ou parcelas e não foram somadas novamente.`
      : 'Nenhuma sobreposição forte foi identificada entre transações pendentes, faturas e parcelas.',
  };
}

function buildMonthlyCommitments(profile = {}, now = new Date()) {
  const month = currentMonthKey(now);
  const lookup = buildLookup(profile);
  const accountCardData = buildAccountsAndCards(profile, now);
  const cardsById = new Map(accountCardData.cards.map(card => [String(card.id || ''), card]));
  const normalizedTransactions = (Array.isArray(profile.transactions) ? profile.transactions : []).map(item => normalizePrimaryTransaction(item, lookup));

  function latestPaymentAccount(entityName, kind, entityId = null) {
    const candidates = normalizedTransactions.filter(record => {
      if (!record.account || record.status !== 'paid') return false;
      if (kind === 'card' && !record.isInvoicePayment) return false;
      if (kind === 'debt') {
        if (entityId && record.debtId && String(record.debtId) === String(entityId)) return true;
        if (!/(pagamento|parcela|divida|dívida|financiamento|emprestimo|empréstimo)/i.test(record.description)) return false;
      }
      const overlap = tokenOverlap(record.description, entityName);
      return overlap.count >= 1 || normalizeText(record.description).includes(normalizeText(entityName));
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return candidates[0]?.account || null;
  }

  const openCardInvoices = (Array.isArray(profile.cards) ? profile.cards : []).map(rawCard => {
    const summary = cardsById.get(String(rawCard?.id || '')) || {};
    const account = resolveBank(rawCard, lookup) || latestPaymentAccount(summary.name || rawCard?.name || rawCard?.nome || '', 'card');
    const owner = inferOwnerForEntity(rawCard, lookup, account);
    return {
      id: summary.id || safeText(rawCard?.id, 120) || null,
      name: summary.name || safeText(rawCard?.name || rawCard?.nome || 'Cartão', 100),
      brand: summary.brand || safeText(rawCard?.brand || rawCard?.bandeira, 40) || null,
      last4: summary.last4 || safeText(rawCard?.last4 || rawCard?.final, 4) || null,
      month,
      invoiceTotal: Number(asNumber(summary.invoiceTotal).toFixed(2)),
      paid: Number(asNumber(summary.paid).toFixed(2)),
      invoiceOpen: Number(asNumber(summary.invoice).toFixed(2)),
      debtBalance: Number(asNumber(summary.debtBalance).toFixed(2)),
      totalOpen: Number(asNumber(summary.totalOpen).toFixed(2)),
      dueDay: summary.dueDay ?? rawCard?.due ?? rawCard?.dueDay ?? rawCard?.vencimento ?? null,
      dueDate: monthDueDate(month, summary.dueDay ?? rawCard?.due ?? rawCard?.dueDay ?? rawCard?.vencimento),
      invoiceSource: summary.invoiceSource || null,
      account: account ? accountSummaryDescriptor(account) : null,
      owner: ownerDescriptor(owner),
      ownershipEvidence: owner ? owner.source : null,
    };
  }).filter(card => card.totalOpen > 0);

  const openDebts = (Array.isArray(profile.debts) ? profile.debts : []).map(rawDebt => {
    const debt = normalizeDebt(rawDebt, lookup);
    const account = debt.account || latestPaymentAccount(debt.name, 'debt', debt.id);
    const owner = inferOwnerForEntity(rawDebt, lookup, account);
    const paidThisMonth = debt.payments
      .filter(payment => String(payment.date || '').slice(0, 7) === month)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const installmentDue = Math.min(debt.installment || debt.remaining, debt.remaining);
    const inferredPaid = paidThisMonth > 0
      ? paidThisMonth
      : debt.lastPaidMonth === month ? Math.min(installmentDue, debt.paid) : 0;
    const installmentOpen = Math.max(0, Number((installmentDue - inferredPaid).toFixed(2)));
    return {
      ...debt,
      account: account ? accountSummaryDescriptor(account) : null,
      owner: ownerDescriptor(owner),
      ownershipEvidence: owner ? owner.source : null,
      month,
      dueDate: debt.dueDate || monthDueDate(month, debt.dueDay),
      installmentDue: Number(installmentDue.toFixed(2)),
      paidThisMonth: Number(inferredPaid.toFixed(2)),
      installmentOpen,
    };
  }).filter(debt => debt.remaining > 0);

  const grouped = new Map();
  function bucketFor(account) {
    const descriptor = account || accountSummaryDescriptor(null);
    const bucket = grouped.get(descriptor.key) || {
      ...descriptor,
      cards: [], debts: [],
      cardInvoicesOpen: 0,
      debtInstallmentsOpen: 0,
      debtBalance: 0,
    };
    grouped.set(descriptor.key, bucket);
    return bucket;
  }
  for (const card of openCardInvoices) {
    const bucket = bucketFor(card.account);
    bucket.cards.push(card);
    bucket.cardInvoicesOpen += card.totalOpen;
  }
  for (const debt of openDebts) {
    const bucket = bucketFor(debt.account);
    bucket.debts.push(debt);
    bucket.debtInstallmentsOpen += debt.installmentOpen;
    bucket.debtBalance += debt.remaining;
  }

  const ownerGrouped = new Map();
  function ownerBucket(owner) {
    const descriptor = owner || ownerDescriptor(null);
    const bucket = ownerGrouped.get(descriptor.key) || {
      ...descriptor,
      cards: [], debts: [], cardInvoicesOpen: 0, debtInstallmentsOpen: 0, debtBalance: 0,
    };
    ownerGrouped.set(descriptor.key, bucket);
    return bucket;
  }
  for (const card of openCardInvoices) {
    const bucket = ownerBucket(card.owner);
    bucket.cards.push(card);
    bucket.cardInvoicesOpen += card.totalOpen;
  }
  for (const debt of openDebts) {
    const bucket = ownerBucket(debt.owner);
    bucket.debts.push(debt);
    bucket.debtInstallmentsOpen += debt.installmentOpen;
    bucket.debtBalance += debt.remaining;
  }

  const byAccount = [...grouped.values()].map(bucket => ({
    ...bucket,
    cardInvoicesOpen: Number(bucket.cardInvoicesOpen.toFixed(2)),
    debtInstallmentsOpen: Number(bucket.debtInstallmentsOpen.toFixed(2)),
    debtBalance: Number(bucket.debtBalance.toFixed(2)),
  })).sort((a, b) => (b.cardInvoicesOpen + b.debtInstallmentsOpen) - (a.cardInvoicesOpen + a.debtInstallmentsOpen));
  const byOwner = [...ownerGrouped.values()].map(bucket => ({
    ...bucket,
    cardInvoicesOpen: Number(bucket.cardInvoicesOpen.toFixed(2)),
    debtInstallmentsOpen: Number(bucket.debtInstallmentsOpen.toFixed(2)),
    debtBalance: Number(bucket.debtBalance.toFixed(2)),
  })).sort((a, b) => (b.cardInvoicesOpen + b.debtInstallmentsOpen) - (a.cardInvoicesOpen + a.debtInstallmentsOpen));

  return {
    month,
    openCardInvoices,
    openDebts,
    byAccount,
    byOwner,
    totals: {
      cardInvoicesOpen: Number(openCardInvoices.reduce((sum, card) => sum + card.totalOpen, 0).toFixed(2)),
      debtInstallmentsOpen: Number(openDebts.reduce((sum, debt) => sum + debt.installmentOpen, 0).toFixed(2)),
      activeDebtBalance: Number(openDebts.reduce((sum, debt) => sum + debt.remaining, 0).toFixed(2)),
    },
  };
}

function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateBR(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}` : '';
}

function overviewPeriodLabel(period, range) {
  if (period === 'month' && range?.start) {
    const date = parseDateValue(range.start);
    if (date) {
      const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date);
      return `Resumo de ${label}`;
    }
  }
  if (period === 'year' && range?.start) return `Resumo de ${String(range.start).slice(0, 4)}`;
  if (range?.start && range?.end) return `Resumo de ${formatDateBR(range.start)} a ${formatDateBR(range.end)}`;
  return 'Resumo financeiro';
}

function buildSuggestedOverviewResponse(overview, complete = false) {
  if (complete && overview.suggestedExecutiveResponse) return overview.suggestedExecutiveResponse;
  const lines = [overviewPeriodLabel(overview.period, overview.range), ''];

  lines.push('VISÃO GERAL');
  lines.push(`Disponível nas contas: ${formatBRL(overview.accountSnapshot?.totalBalance || 0)}`);
  lines.push(`Receitas realizadas: ${formatBRL(overview.income)}`);
  lines.push(`Despesas realizadas: ${formatBRL(overview.expenses)}`);
  lines.push(`Saldo do período: ${formatBRL(overview.balance)}`);

  lines.push('', 'PENDÊNCIAS DO PERÍODO');
  if (overview.pendingExpenses > 0) lines.push(`Despesas pendentes: ${formatBRL(overview.pendingExpenses)} em ${overview.counts.pendingExpenses} lançamento(s)`);
  if (overview.pendingIncome > 0) lines.push(`Receitas pendentes: ${formatBRL(overview.pendingIncome)} em ${overview.counts.pendingIncome} lançamento(s)`);
  if (overview.pendingExpenses <= 0 && overview.pendingIncome <= 0) lines.push('Nenhuma pendência cadastrada para o período.');
  for (const item of overview.pendingItems.slice(0, 8)) {
    const account = item.account?.name || item.card?.name || 'Sem conta vinculada';
    lines.push(`• ${formatDateBR(item.date)} · ${item.description} · ${formatBRL(item.amount)} · ${account}`);
  }
  if (overview.pendingItems.length > 8) lines.push(`• Mais ${overview.pendingItems.length - 8} pendência(s).`);
  lines.push('', `Saldo do período após as transações pendentes: ${formatBRL(overview.projectedBalance)}`);
  if (overview.commitmentsApplicable && overview.commitmentAnalysis?.uniqueCashOutflow > 0) {
    lines.push(`Necessidade de caixa do mês: ${formatBRL(overview.commitmentAnalysis.uniqueCashOutflow)}`);
    lines.push(`Saldo disponível após todos os compromissos identificados: ${formatBRL(overview.commitmentAnalysis.projectedAvailable)}`);
  }
  return lines.join('\n');
}

function buildCompleteByAccountResponse(overview) {
  const lines = [overviewPeriodLabel(overview.period, overview.range).toLocaleUpperCase('pt-BR'), ''];
  const snapshot = overview.accountSnapshot || { accounts: [], byOwner: [], totalBalance: 0 };
  const analysis = overview.commitmentAnalysis || {};

  lines.push('VISÃO GERAL');
  lines.push(`Disponível agora nas contas: ${formatBRL(snapshot.totalBalance)}`);
  for (const account of snapshot.accounts) lines.push(`• ${account.name}: ${formatBRL(account.balance)}`);
  lines.push(`Receitas realizadas no mês: ${formatBRL(overview.income)}`);
  lines.push(`Despesas realizadas no mês: ${formatBRL(overview.expenses)}`);
  lines.push(`Saldo das movimentações do mês: ${formatBRL(overview.balance)}`);

  lines.push('', 'COMPROMISSOS DO MÊS');
  lines.push(`Transações pendentes diretas: ${formatBRL(analysis.directPendingExpenses || 0)}`);
  lines.push(`Faturas de cartão em aberto: ${formatBRL(overview.commitments?.totals?.cardInvoicesOpen || 0)}`);
  lines.push(`Parcelas de dívidas em aberto: ${formatBRL(overview.commitments?.totals?.debtInstallmentsOpen || 0)}`);
  lines.push(`Total líquido a pagar, sem sobreposições identificadas: ${formatBRL(analysis.uniqueCashOutflow || 0)}`);
  if ((analysis.overlappedPendingItems || []).length) {
    lines.push(`Itens não somados novamente por possível duplicidade: ${formatBRL(analysis.overlappedPendingExpenses || 0)} em ${analysis.overlappedPendingItems.length} lançamento(s)`);
  }
  lines.push(`Receitas pendentes previstas: ${formatBRL(overview.pendingIncome)}`);
  lines.push(`Saldo após os compromissos, usando apenas o dinheiro disponível agora: ${formatBRL(analysis.projectedWithoutPendingIncome ?? snapshot.totalBalance)}`);
  if ((analysis.pendingIncome || 0) > 0) lines.push(`Saldo após os compromissos, considerando também receitas pendentes: ${formatBRL(analysis.projectedAvailable || 0)}`);
  if ((analysis.shortfallNow || 0) > 0) lines.push(`Falta hoje para cobrir tudo: ${formatBRL(analysis.shortfallNow)}`);
  else lines.push(`Margem disponível hoje: ${formatBRL(Math.max(0, analysis.projectedWithoutPendingIncome || 0))}`);
  if ((analysis.pendingIncome || 0) > 0 && (analysis.shortfall || 0) > 0) lines.push(`Falta após as receitas pendentes: ${formatBRL(analysis.shortfall)}`);

  const transactionByOwner = new Map();
  for (const owner of overview.byOwner || []) {
    transactionByOwner.set(owner.key, {
      ...owner,
      accounts: [...(owner.accounts || [])],
    });
  }
  for (const owner of snapshot.byOwner || []) {
    const bucket = transactionByOwner.get(owner.key) || {
      ...owner,
      paidIncome: 0,
      paidExpenses: 0,
      pendingIncome: 0,
      pendingExpenses: 0,
      partialIncome: 0,
      partialExpenses: 0,
      realizedBalance: 0,
    };
    bucket.accounts = owner.accounts;
    transactionByOwner.set(owner.key, bucket);
  }

  const commitmentsByOwner = new Map((overview.commitments?.byOwner || []).map(owner => [owner.key, owner]));
  const pendingByOwner = new Map();
  for (const item of analysis.directPendingItems || []) {
    const key = item.owner?.key || '__sem_proprietario__';
    const list = pendingByOwner.get(key) || [];
    list.push(item);
    pendingByOwner.set(key, list);
  }

  const allOwnerKeys = new Set([...transactionByOwner.keys(), ...commitmentsByOwner.keys(), ...pendingByOwner.keys()]);
  const ownerGroups = [...allOwnerKeys].map(key => {
    const tx = transactionByOwner.get(key) || {};
    const commitment = commitmentsByOwner.get(key) || {};
    return {
      key,
      label: tx.label || commitment.label || 'Sem vínculo identificado',
      unassigned: tx.unassigned ?? commitment.unassigned ?? true,
      accounts: tx.accounts || [],
      paidIncome: tx.paidIncome || 0,
      paidExpenses: tx.paidExpenses || 0,
      realizedBalance: tx.realizedBalance || 0,
      pendingIncome: tx.pendingIncome || 0,
      pendingExpenses: tx.pendingExpenses || 0,
      cards: commitment.cards || [],
      debts: commitment.debts || [],
      directPendingItems: pendingByOwner.get(key) || [],
    };
  }).filter(group => group.accounts.length || group.paidIncome || group.paidExpenses || group.pendingIncome || group.pendingExpenses || group.cards.length || group.debts.length || group.directPendingItems.length)
    .sort((a, b) => {
      if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
      const total = group => group.paidIncome + group.paidExpenses + group.pendingIncome + group.pendingExpenses + group.cards.reduce((s,c)=>s+c.totalOpen,0) + group.debts.reduce((s,d)=>s+d.installmentOpen,0);
      return total(b) - total(a);
    });

  for (const group of ownerGroups) {
    lines.push('', String(group.label).toLocaleUpperCase('pt-BR'));
    const bankBalance = group.accounts.reduce((sum, account) => sum + account.balance, 0);
    if (group.accounts.length) {
      lines.push(`Saldo nas contas: ${formatBRL(bankBalance)}`);
      for (const account of group.accounts) lines.push(`• ${account.name}: ${formatBRL(account.balance)}`);
    }
    lines.push(`Realizado: receitas ${formatBRL(group.paidIncome)} · despesas ${formatBRL(group.paidExpenses)} · saldo ${formatBRL(group.realizedBalance)}`);

    const pendingItems = group.directPendingItems;
    if (pendingItems.length) {
      const total = pendingItems.reduce((sum, item) => sum + item.amount, 0);
      lines.push(`Contas pendentes diretas: ${formatBRL(total)}`);
      for (const item of pendingItems.slice(0, 10)) lines.push(`• ${formatDateBR(item.date)} · ${item.description} · ${formatBRL(item.amount)}`);
    } else if (group.pendingIncome > 0) {
      lines.push(`Receitas pendentes: ${formatBRL(group.pendingIncome)}`);
    }

    if (group.cards.length) {
      lines.push('Faturas abertas:');
      for (const card of group.cards.slice(0, 10)) {
        const due = card.dueDate ? ` · vence em ${formatDateBR(card.dueDate)}` : '';
        const detail = card.debtBalance > 0 ? ` · fatura ${formatBRL(card.invoiceOpen)} + saldo financiado ${formatBRL(card.debtBalance)}` : '';
        lines.push(`• ${card.name} · ${formatBRL(card.totalOpen)}${detail}${due}`);
      }
    }
    if (group.debts.length) {
      lines.push('Dívidas e financiamentos:');
      for (const debt of group.debts.slice(0, 10)) {
        const due = debt.dueDate ? ` · vence em ${formatDateBR(debt.dueDate)}` : '';
        lines.push(`• ${debt.name} · parcela do mês ${formatBRL(debt.installmentOpen)} · saldo devedor ${formatBRL(debt.remaining)}${due}`);
      }
    }
    const ownerCommitments = group.directPendingItems.reduce((sum, item) => sum + item.amount, 0)
      + group.cards.reduce((sum, card) => sum + card.totalOpen, 0)
      + group.debts.reduce((sum, debt) => sum + debt.installmentOpen, 0);
    const ownerResources = bankBalance + group.pendingIncome;
    if (ownerCommitments > 0) {
      lines.push(`Total a pagar neste mês: ${formatBRL(ownerCommitments)}`);
      lines.push(`Saldo do grupo após os compromissos: ${formatBRL(ownerResources - ownerCommitments)}`);
    }
  }

  const overdue = analysis.due?.overdue || [];
  const soon = [...(analysis.due?.today || []), ...(analysis.due?.next7Days || [])];
  if (overdue.length || soon.length) {
    lines.push('', 'PRIORIDADES');
    if (overdue.length) {
      lines.push(`Vencidos: ${formatBRL(overdue.reduce((sum, item) => sum + item.amount, 0))}`);
      for (const item of overdue.slice(0, 6)) lines.push(`• ${formatDateBR(item.date)} · ${item.name} · ${formatBRL(item.amount)}`);
    }
    if (soon.length) {
      lines.push(`Vencem hoje ou nos próximos 7 dias: ${formatBRL(soon.reduce((sum, item) => sum + item.amount, 0))}`);
      for (const item of soon.slice(0, 6)) lines.push(`• ${formatDateBR(item.date)} · ${item.name} · ${formatBRL(item.amount)}`);
    }
  }

  lines.push('', 'DÍVIDAS ATIVAS');
  lines.push(`Saldo devedor total: ${formatBRL(overview.commitments?.totals?.activeDebtBalance || 0)}`);
  lines.push('', 'LEITURA RÁPIDA');
  if ((analysis.shortfallNow || 0) > 0) lines.push(`Com o dinheiro disponível hoje, faltam ${formatBRL(analysis.shortfallNow)} para cobrir os compromissos identificados.`);
  else lines.push(`O dinheiro disponível hoje cobre os compromissos identificados, com margem de ${formatBRL(Math.max(0, analysis.projectedWithoutPendingIncome || 0))}.`);
  if ((analysis.pendingIncome || 0) > 0) {
    if ((analysis.shortfall || 0) > 0) lines.push(`Mesmo considerando as receitas pendentes, ainda faltariam ${formatBRL(analysis.shortfall)}.`);
    else lines.push(`Considerando as receitas pendentes, a margem projetada sobe para ${formatBRL(Math.max(0, analysis.projectedAvailable || 0))}.`);
  }
  if ((analysis.overlappedPendingItems || []).length) lines.push(analysis.note);
  if ((overview.dataQuality?.unassignedCommitments || 0) > 0) lines.push(`${overview.dataQuality.unassignedCommitments} compromisso(s) continuam sem identificação segura de proprietário; revise o nome ou vínculo no cadastro.`);
  if ((overview.dataQuality?.unresolvedAccountReferences || 0) > 0) lines.push(`${overview.dataQuality.unresolvedAccountReferences} lançamento(s) possuem um identificador de conta que não corresponde a nenhuma conta cadastrada.`);
  lines.push('O saldo devedor total das dívidas é informativo e não foi somado inteiro ao mês; apenas a parcela em aberto entrou na necessidade de caixa.');
  return lines.join('\n').trim();
}

function financialOverview(profile, args = {}, now = new Date()) {
  const { items } = collectTransactions(profile);
  const inRange = items.filter(record => recordMatchesPeriod(record, args, now));
  const relevant = inRange.filter(financialRecordIsRelevant);

  const paidIncome = relevant.filter(record => record.countsAsIncome);
  const paidExpenses = relevant.filter(record => record.countsAsSpending);
  const pending = relevant.filter(record => record.status === 'pending');
  const partial = relevant.filter(record => record.status === 'partial');
  const cancelled = inRange.filter(record => record.status === 'cancelled');

  const pendingIncomeRecords = pending.filter(record => record.type === 'income');
  const pendingExpenseRecords = pending.filter(record => record.type === 'expense');
  const partialIncomeRecords = partial.filter(record => record.type === 'income');
  const partialExpenseRecords = partial.filter(record => record.type === 'expense');

  const income = paidIncome.reduce((sum, record) => sum + record.amount, 0);
  const expenses = paidExpenses.reduce((sum, record) => sum + record.amount, 0);
  const pendingIncome = pendingIncomeRecords.reduce((sum, record) => sum + record.amount, 0);
  const pendingExpenses = pendingExpenseRecords.reduce((sum, record) => sum + record.amount, 0);
  const partialIncome = partialIncomeRecords.reduce((sum, record) => sum + record.amount, 0);
  const partialExpenses = partialExpenseRecords.reduce((sum, record) => sum + record.amount, 0);
  const range = periodRange(args.period || 'month', now, { startDate: args.startDate, endDate: args.endDate });
  const accountBreakdown = buildAccountBreakdown(relevant);
  const orderedPending = sortPendingRecords(pending);
  const currentMonth = currentMonthKey(now);
  const requestedMonth = range.startKey ? String(range.startKey).slice(0, 7) : null;
  const commitmentsApplicable = (args.period || 'month') === 'month' && requestedMonth === currentMonth;
  const commitments = commitmentsApplicable
    ? buildMonthlyCommitments(profile, now)
    : { month: requestedMonth, openCardInvoices: [], openDebts: [], byAccount: [], byOwner: [], totals: { cardInvoicesOpen: 0, debtInstallmentsOpen: 0, activeDebtBalance: 0 } };
  const accountSnapshot = buildAccountSnapshot(profile);
  const commitmentAnalysis = commitmentsApplicable
    ? buildCommitmentAnalysis(pendingExpenseRecords, pendingIncome, commitments, accountSnapshot, now)
    : buildCommitmentAnalysis(pendingExpenseRecords, pendingIncome, commitments, accountSnapshot, now);

  const overview = {
    period: args.period || 'month',
    range: { start: range.startKey, end: range.endKey },
    income: Number(income.toFixed(2)),
    expenses: Number(expenses.toFixed(2)),
    balance: Number((income - expenses).toFixed(2)),
    pendingIncome: Number(pendingIncome.toFixed(2)),
    pendingExpenses: Number(pendingExpenses.toFixed(2)),
    partialIncome: Number(partialIncome.toFixed(2)),
    partialExpenses: Number(partialExpenses.toFixed(2)),
    projectedBalance: Number((income - expenses + pendingIncome - pendingExpenses).toFixed(2)),
    counts: {
      totalRecords: inRange.length,
      relevantRecords: relevant.length,
      paidIncome: paidIncome.length,
      paidExpenses: paidExpenses.length,
      pending: pending.length,
      pendingIncome: pendingIncomeRecords.length,
      pendingExpenses: pendingExpenseRecords.length,
      partial: partial.length,
      cancelled: cancelled.length,
      transfers: inRange.filter(record => record.isTransfer).length,
      benefitCovered: inRange.filter(record => record.coveredByBenefit).length,
      invoicePayments: inRange.filter(record => record.isInvoicePayment).length,
      cardPurchases: inRange.filter(record => record.kind === 'card_purchase').length,
    },
    byCategory: aggregate(paidExpenses, record => ({
      key: record.category?.id || record.category?.name || 'outros', name: record.category?.name || 'Outros', emoji: record.category?.emoji || '🏷️',
    })),
    pendingByCategory: aggregate(pendingExpenseRecords, record => ({
      key: record.category?.id || record.category?.name || 'outros', name: record.category?.name || 'Outros', emoji: record.category?.emoji || '🏷️',
    })),
    byAccount: accountBreakdown,
    byOwner: buildOwnerFinancialBreakdown(relevant, profile),
    paidByAccount: aggregate([...paidIncome, ...paidExpenses], record => {
      const descriptor = accountDescriptor(record);
      return { key: descriptor.key, name: descriptor.name, institution: descriptor.institution, unassigned: descriptor.unassigned };
    }),
    pendingByAccount: accountBreakdown.filter(account => account.pendingIncome > 0 || account.pendingExpenses > 0).map(account => ({
      key: account.key, id: account.id, name: account.name, institution: account.institution, unassigned: account.unassigned,
      pendingIncome: account.pendingIncome, pendingExpenses: account.pendingExpenses, pendingRecords: account.pendingRecords,
    })),
    byCard: aggregate(paidExpenses.filter(record => record.card), record => ({ key: record.card.id, name: record.card.name, brand: record.card.brand })),
    pendingItems: orderedPending.slice(0, 30).map(compactFinancialRecord),
    partialItems: sortPendingRecords(partial).slice(0, 20).map(compactFinancialRecord),
    recentPaidExpenses: [...paidExpenses].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 10).map(compactFinancialRecord),
    commitmentsApplicable,
    commitments,
    accountSnapshot,
    commitmentAnalysis,
    dataQuality: {
      unresolvedAccountReferences: inRange.filter(record => record.accountId && !record.account).length,
      unassignedCommitments: (commitments.openCardInvoices || []).filter(item => item.owner?.unassigned).length + (commitments.openDebts || []).filter(item => item.owner?.unassigned).length,
      detectedOverlaps: commitmentAnalysis.overlappedPendingItems.length,
    },
  };

  overview.suggestedExecutiveResponse = buildCompleteByAccountResponse(overview);
  overview.suggestedResponse = buildSuggestedOverviewResponse(overview, false);
  overview.suggestedCompleteResponse = overview.suggestedExecutiveResponse;
  overview.suggestedCompleteByAccountResponse = overview.suggestedExecutiveResponse;
  overview.responseGuidance = {
    broadSummary: 'Para pedidos simples de resumo, use suggestedResponse como base.',
    completeSummary: 'Para resumo completo/detalhado/tudo do mês ou separação Gui/Luh, reproduza suggestedExecutiveResponse sem remover saldos bancários, faturas, dívidas, prioridades ou análise de cobertura.',
    pending: 'pendingExpenses é o total bruto cadastrado. commitmentAnalysis.directPendingExpenses é o valor pendente direto sem itens já reconhecidos em faturas ou parcelas.',
    commitments: 'commitmentAnalysis.uniqueCashOutflow é a necessidade de caixa sem sobreposições fortes identificadas. Nunca some o saldo devedor total inteiro como compromisso do mês.',
    owners: 'commitments.byOwner agrupa cartões e dívidas por proprietário inferido a partir de nomes como Gui/Luh, sem fingir que existe bankId formal.',
  };
  return overview;
}

function filterRecords(records, args = {}) {
  const query = normalizeText(args.query);
  const category = normalizeText(args.category);
  const account = normalizeText(args.account);
  const card = normalizeText(args.card);
  const benefit = normalizeText(args.benefit);
  const minAmount = args.minAmount === null || args.minAmount === undefined ? null : Number(args.minAmount);
  const maxAmount = args.maxAmount === null || args.maxAmount === undefined ? null : Number(args.maxAmount);

  let result = records.filter(record => recordMatchesPeriod(record, args));
  result = result.filter(record => {
    if (args.type && args.type !== 'all' && record.type !== args.type) return false;
    if (args.status && args.status !== 'all' && record.status !== args.status) return false;
    if (args.recurrence && args.recurrence !== 'all' && record.recurrence !== args.recurrence) return false;
    if (args.source && args.source !== 'all' && record.source !== args.source) return false;
    if (args.includeTransfers === false && record.isTransfer) return false;
    if (Number.isFinite(minAmount) && record.amount < minAmount) return false;
    if (Number.isFinite(maxAmount) && record.amount > maxAmount) return false;
    if (category && !normalizeText(`${record.category?.name} ${record.category?.id}`).includes(category)) return false;
    if (account && !normalizeText(`${record.account?.name} ${record.account?.institution} ${record.account?.id}`).includes(account)) return false;
    if (card && !normalizeText(`${record.card?.name} ${record.card?.brand} ${record.card?.last4} ${record.card?.id}`).includes(card)) return false;
    if (benefit && !normalizeText(`${record.benefit?.name} ${record.benefit?.id}`).includes(benefit)) return false;
    if (query) {
      const haystack = normalizeText([
        record.description,
        record.notes,
        record.category?.name,
        record.account?.name,
        record.account?.institution,
        record.card?.name,
        record.card?.brand,
        record.benefit?.name,
        record.source,
      ].filter(Boolean).join(' '));
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const sort = args.sort || 'date_desc';
  result.sort((a, b) => {
    if (sort === 'date_asc') return String(a.date || '').localeCompare(String(b.date || ''));
    if (sort === 'amount_desc') return b.amount - a.amount;
    if (sort === 'amount_asc') return a.amount - b.amount;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
  return result;
}

function normalizeGoal(goal = {}) {
  const target = asNumber(goal.target ?? goal.meta ?? goal.valorMeta);
  const current = asNumber(goal.current ?? goal.atual ?? goal.saved ?? goal.valorAtual);
  return {
    id: safeText(goal.id, 120) || null,
    name: safeText(goal.name || goal.nome || 'Meta', 120),
    target,
    current,
    remaining: Math.max(0, target - current),
    progressPercent: target > 0 ? Number(Math.min(100, current / target * 100).toFixed(1)) : 0,
    deadline: transactionDateKey({ date: goal.deadline ?? goal.prazo ?? goal.date }) || null,
  };
}

function normalizeDebt(debt = {}, lookup) {
  const payments = (Array.isArray(debt?.payments) ? debt.payments : []).slice(-50).map(payment => ({
    id: safeText(payment?.id, 120) || null,
    amount: amountOf(payment),
    date: transactionDateKey(payment) || null,
    account: resolveBank(payment, lookup),
    bankId: safeText(payment?.bankId || payment?.accountId, 120) || null,
  }));
  const explicitBank = resolveBank(debt, lookup);
  const paymentBank = [...payments].reverse().find(payment => payment.account)?.account || null;
  const bank = explicitBank || paymentBank;
  const total = asNumber(debt.total ?? debt.amount ?? debt.valor ?? debt.saldoDevedor ?? debt.balance);
  const paid = asNumber(debt.paid ?? debt.pago ?? debt.valorPago);
  return {
    id: safeText(debt.id, 120) || null,
    name: safeText(debt.name || debt.nome || debt.description || debt.descricao || 'Dívida', 140),
    creditor: safeText(debt.creditor || debt.credor || debt.institution || debt.instituicao, 120) || null,
    total,
    paid,
    remaining: Math.max(0, asNumber(debt.remaining ?? debt.restante ?? debt.balance ?? debt.saldoDevedor) || (total - paid)),
    installment: asNumber(debt.installment ?? debt.parcela ?? debt.installmentValue ?? debt.valorParcela),
    installments: Math.trunc(asNumber(debt.installments ?? debt.parcelas ?? debt.installmentsTotal ?? debt.parcelasTotal)),
    installmentsPaid: Math.trunc(asNumber(debt.installmentsPaid ?? debt.parcelasPagas)),
    startDate: transactionDateKey({ date: debt.startDate ?? debt.dataInicio }) || null,
    dueDay: Math.trunc(asNumber(debt.dueDay ?? debt.diaVencimento ?? debt.vencimentoDia)) || null,
    dueDate: transactionDateKey({ date: debt.dueDate ?? debt.vencimento ?? debt.date }) || null,
    lastPaidMonth: safeText(debt.lastPaidMonth, 7) || null,
    status: normalizeStatus(debt),
    account: bank,
    payments,
    notes: safeText(debt.notes || debt.obs || debt.observacao, 300) || null,
  };
}

function normalizeVault(vault = {}, lookup) {
  const history = (Array.isArray(vault.history) ? vault.history : []).slice(-20).map(entry => ({
    type: safeText(entry.type, 30),
    amount: amountOf(entry),
    date: transactionDateKey(entry) || null,
    account: resolveBank(entry, lookup),
  }));
  return {
    id: safeText(vault.id, 120) || null,
    name: safeText(vault.name || vault.nome || 'Cofre', 120),
    emoji: safeText(vault.emoji || '🔒', 8),
    balance: asNumber(vault.balance ?? vault.saldo),
    target: asNumber(vault.meta ?? vault.target),
    yieldType: safeText(vault.yieldType || vault.tipoRendimento, 40) || null,
    yieldRate: asNumber(vault.yieldRate ?? vault.taxaRendimento),
    history,
  };
}

function benefitDetails(profile = {}) {
  const lookup = buildLookup(profile);
  return (Array.isArray(profile.benefits) ? profile.benefits : []).map(benefit => {
    const basic = lookup.benefits.get(String(benefit?.id || ''));
    return {
      ...basic,
      transactions: (Array.isArray(benefit?.transactions) ? benefit.transactions : []).slice(-50).map(tx => ({
        id: safeText(tx?.id, 120) || null,
        description: safeText(tx?.description || tx?.desc || tx?.descricao || 'Uso do benefício', 160),
        amount: amountOf(tx),
        date: transactionDateKey(tx) || null,
      })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    };
  });
}

function driverSummary(profile = {}, args = {}) {
  const lookup = buildLookup(profile);
  const filter = items => (Array.isArray(items) ? items : []).filter(item => inPeriod(item, args.period || 'month', new Date(), { startDate: args.startDate, endDate: args.endDate }));
  const journeys = filter(profile.uberJornadas);
  const rides = filter(profile.uberCorridas);
  const expenses = filter(profile.uberGastos);
  const fuel = filter(profile.uberAbastec);
  const grossRevenue = rides.reduce((sum, item) => sum + asNumber(item?.valor ?? item?.amount), 0);
  const generalExpenses = expenses.reduce((sum, item) => sum + asNumber(item?.valor ?? item?.amount), 0);
  const fuelExpenses = fuel.reduce((sum, item) => sum + asNumber(item?.valorTotal ?? item?.amount), 0);
  return {
    period: args.period || 'month',
    journeys: journeys.map(item => ({
      id: item.id || null,
      date: transactionDateKey(item) || null,
      name: safeText(item.nome || 'Jornada', 100),
      durationSeconds: asNumber(item.duracao),
      pausedSeconds: asNumber(item.totalPausado),
      km: asNumber(item.kmRodados),
    })),
    rides: rides.map(item => ({
      id: item.id || null,
      date: transactionDateKey(item) || null,
      platform: safeText(item.plataforma, 40),
      quantity: Math.trunc(asNumber(item.qtd)),
      revenue: asNumber(item.valor),
      km: asNumber(item.km),
      vehicle: lookup.vehicles.get(String(item.veiculoId || '')) || null,
      notes: safeText(item.obs, 200) || null,
    })),
    expenses: expenses.map(item => ({
      id: item.id || null,
      date: transactionDateKey(item) || null,
      type: safeText(item.tipo, 60),
      amount: asNumber(item.valor),
      description: safeText(item.desc, 160) || null,
      vehicle: lookup.vehicles.get(String(item.veiculoId || '')) || null,
    })),
    fuel: fuel.map(item => ({
      id: item.id || null,
      date: transactionDateKey(item) || null,
      amount: asNumber(item.valorTotal),
      liters: asNumber(item.litros),
      pricePerLiter: asNumber(item.precoPorLitro),
      odometer: asNumber(item.kmAtual),
      average: asNumber(item.media),
      fullTank: item.tanqueCheio === true,
      vehicle: lookup.vehicles.get(String(item.veiculoId || '')) || null,
    })),
    totals: {
      grossRevenue: Number(grossRevenue.toFixed(2)),
      generalExpenses: Number(generalExpenses.toFixed(2)),
      fuelExpenses: Number(fuelExpenses.toFixed(2)),
      totalExpenses: Number((generalExpenses + fuelExpenses).toFixed(2)),
      net: Number((grossRevenue - generalExpenses - fuelExpenses).toFixed(2)),
      rides: rides.reduce((sum, item) => sum + Math.trunc(asNumber(item.qtd)), 0),
      km: Number(rides.reduce((sum, item) => sum + asNumber(item.km), 0).toFixed(1)),
    },
    vehicles: [...lookup.vehicles.values()],
  };
}

function getAccountActivity(profile = {}, args = {}) {
  const { lookup, items } = collectTransactions(profile);
  const matched = args.account
    ? lookup.bankSearch.filter(bank => normalizeText(`${bank.id} ${bank.name} ${bank.institution}`).includes(normalizeText(args.account)))
    : lookup.bankSearch;
  const ids = new Set(matched.map(bank => bank.id));
  const activities = [];

  for (const record of items) {
    if (!record.accountId || !ids.has(record.accountId) || !recordMatchesPeriod(record, args)) continue;
    activities.push({
      id: record.id,
      kind: record.isTransfer ? 'transfer' : 'transaction',
      date: record.date,
      description: record.description,
      amount: record.amount,
      type: record.type,
      status: record.status,
      account: record.account,
      category: record.category,
      card: record.card,
      notes: record.notes,
    });
  }

  for (const rawBank of Array.isArray(profile.banks) ? profile.banks : []) {
    if (!ids.has(String(rawBank?.id || ''))) continue;
    const account = lookup.banks.get(String(rawBank.id));
    for (const entry of Array.isArray(rawBank.balanceHistory) ? rawBank.balanceHistory : []) {
      const normalized = { date: transactionDateKey(entry) };
      if (!recordMatchesPeriod(normalized, args)) continue;
      activities.push({
        id: entry.id || null,
        kind: 'balance_adjustment',
        date: normalized.date,
        description: safeText(entry.note || 'Conciliação de saldo', 160),
        amount: Math.abs(asNumber(entry.delta)),
        delta: asNumber(entry.delta),
        oldBalance: asNumber(entry.oldBalance),
        newBalance: asNumber(entry.newBalance),
        account,
      });
    }
  }

  for (const vault of Array.isArray(profile.cofres) ? profile.cofres : []) {
    for (const entry of Array.isArray(vault?.history) ? vault.history : []) {
      const accountId = String(entry?.bankId || '');
      if (!ids.has(accountId)) continue;
      const normalized = { date: transactionDateKey(entry) };
      if (!recordMatchesPeriod(normalized, args)) continue;
      activities.push({
        id: entry.id || null,
        kind: entry.type === 'deposit' ? 'vault_deposit' : 'vault_withdrawal',
        date: normalized.date,
        description: `${entry.type === 'deposit' ? 'Depósito em' : 'Retirada de'} ${safeText(vault.name || 'cofre', 100)}`,
        amount: amountOf(entry),
        account: lookup.banks.get(accountId) || null,
        vault: { id: vault.id || null, name: safeText(vault.name || 'Cofre', 100) },
      });
    }
  }

  activities.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return {
    matchedAccounts: matched,
    count: activities.length,
    activities: activities.slice(0, Math.max(1, Math.min(100, args.limit || 50))),
  };
}

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

const tools = [
  {
    type: 'function',
    name: 'get_app_capabilities',
    description: 'Explica as áreas e funcionalidades existentes no Allo Finanças e quais dados o Allofy consegue consultar. Use quando a pergunta for sobre como o aplicativo funciona.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_app_overview',
    description: 'Retorna um mapa resumido dos cadastros do usuário: quantidades de transações, contas, cartões, categorias, metas, dívidas, cofres, benefícios e dados do modo motorista.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_financial_overview',
    description: 'Calcula o resumo financeiro do período. No mês atual inclui saldos bancários, pendências, faturas, parcelas e saldo devedor, agrupamento por proprietário/conta, vencidos, próximos vencimentos, cobertura do saldo e deduplicação de compromissos. Para resumo completo use suggestedExecutiveResponse exatamente como base.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS },
        startDate: nullableString,
        endDate: nullableString,
        exactDate: nullableString,
      },
      required: ['period', 'startDate', 'endDate', 'exactDate'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_transactions',
    description: 'Pesquisa transações e compras reais com todos os detalhes, incluindo conta bancária resolvida pelo bankId, cartão, categoria, data, status, recorrência, observação, benefício e origem.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS },
        startDate: nullableString,
        endDate: nullableString,
        exactDate: nullableString,
        type: { type: 'string', enum: ['income', 'expense', 'all'] },
        status: { type: 'string', enum: ['all', 'paid', 'pending', 'partial', 'cancelled'] },
        category: nullableString,
        account: nullableString,
        card: nullableString,
        benefit: nullableString,
        query: nullableString,
        recurrence: { type: 'string', enum: ['all', 'fixed', 'variable', 'installment'] },
        source: { type: 'string', enum: ['all', 'bank', 'card', 'benefit', 'driver', 'import', 'whatsapp', 'manual'] },
        includeTransfers: { type: 'boolean' },
        minAmount: nullableNumber,
        maxAmount: nullableNumber,
        sort: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['period', 'startDate', 'endDate', 'exactDate', 'type', 'status', 'category', 'account', 'card', 'benefit', 'query', 'recurrence', 'source', 'includeTransfers', 'minAmount', 'maxAmount', 'sort', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_transaction_details',
    description: 'Busca os detalhes completos de uma transação ou compra pelo identificador retornado na pesquisa.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { transactionId: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['transactionId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_account_activity',
    description: 'Consulta o extrato detalhado de uma conta bancária, resolvendo nome/apelido/instituição e incluindo transações, transferências, conciliações de saldo e movimentos de cofres.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        account: nullableString,
        period: { type: 'string', enum: PERIODS },
        startDate: nullableString,
        endDate: nullableString,
        exactDate: nullableString,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['account', 'period', 'startDate', 'endDate', 'exactDate', 'limit'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_accounts_and_cards',
    description: 'Consulta todas as contas, apelidos, instituições, tipos, saldos, cartões, faturas atuais, compras cadastradas, pagamentos, limites e benefícios.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_categories',
    description: 'Consulta as categorias cadastradas, emojis, limites e quantidade de transações associadas.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_planning',
    description: 'Consulta metas, dívidas e cofres com valores, progresso, vencimentos, contas vinculadas e histórico recente.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_benefits',
    description: 'Consulta benefícios como VA/VR/combustível, saldo disponível e usos detalhados.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_driver_summary',
    description: 'Consulta jornadas, corridas, receitas, gastos, abastecimentos e veículos do módulo motorista por período.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: PERIODS },
        startDate: nullableString,
        endDate: nullableString,
      },
      required: ['period', 'startDate', 'endDate'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_user_memory',
    description: 'Lê preferências não sensíveis que o usuário pediu para o Allofy lembrar.',
    strict: true,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'save_user_memory',
    description: 'Salva preferências não sensíveis explicitamente informadas pelo usuário. Nunca salva senhas, tokens ou dados completos de cartão.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 180 } } },
      required: ['items'],
      additionalProperties: false,
    },
  },
];

async function loadProfile(uid) {
  return hydrateProfile(uid);
}

function appCapabilities() {
  return {
    app: 'Allo Finanças',
    access: 'Leitura e ações operacionais autenticadas dentro do Allofy',
    modules: [
      { name: 'Início', capabilities: ['resumo mensal', 'saldo', 'receitas', 'despesas', 'últimas movimentações'] },
      { name: 'Extrato', capabilities: ['receitas e despesas', 'status pago/pendente', 'data', 'categoria', 'conta bancária', 'cartão', 'benefício', 'recorrência', 'observações', 'transferências'] },
      { name: 'Contas bancárias', capabilities: ['múltiplas contas', 'apelido e instituição', 'saldo', 'tipo', 'extrato por conta', 'transferências', 'conciliações de saldo'] },
      { name: 'Cartões', capabilities: ['compras', 'parcelas', 'juros', 'categoria', 'data da compra', 'fatura manual ou calculada', 'pagamentos', 'limite'] },
      { name: 'Relatórios', capabilities: ['7 e 30 dias', 'mês', 'ano', 'personalizado', 'categoria', 'origem dos gastos', 'insights'] },
      { name: 'Planejamento', capabilities: ['metas', 'dívidas', 'cofres', 'orçamentos por categoria'] },
      { name: 'Benefícios', capabilities: ['VA/VR/combustível', 'usos e saldo restante'] },
      { name: 'Motorista', capabilities: ['jornadas', 'corridas', 'receitas', 'gastos', 'abastecimentos', 'veículos'] },
      { name: 'Allofy', capabilities: ['pesquisa detalhada', 'resumos', 'comparações', 'filtros por data, conta, cartão, categoria e status', 'criar receitas e despesas', 'registrar compras no cartão', 'registrar transferências internas', 'criar metas, dívidas, categorias, contas e cartões', 'registrar pagamentos de dívida', 'atualizar fatura', 'desfazer ações auditadas', 'voz e modo ao vivo'] },
    ],
    dataRelationships: {
      transactionAccount: 'A conta escolhida na transação é salva em bankId e deve ser resolvida na lista banks.',
      transactionCategory: 'A categoria geralmente é salva pelo id em category e deve ser resolvida na lista categories.',
      transactionCard: 'O cartão é ligado por cardId; compras modernas também ficam em cardTransactions.',
      transactionBenefit: 'Benefícios são ligados por benefitId e coveredByBenefit.',
      transactionDates: 'date/dataCompra é a data financeira; createdAt é apenas quando o registro foi criado.',
    },
  };
}

async function executeAllofyTool(name, args, uid, prefetchedProfile = null, context = {}) {
  const profile = prefetchedProfile || await loadProfile(uid);

  if (name === 'get_app_capabilities') return appCapabilities();
  if (name === 'get_app_overview') return {
    user: { name: safeText(profile.name || profile.nome, 100) || null, email: safeText(profile.email, 160) || null },
    counts: {
      transactions: Array.isArray(profile.transactions) ? profile.transactions.length : 0,
      cardPurchases: Array.isArray(profile.cardTransactions) ? profile.cardTransactions.length : 0,
      accounts: Array.isArray(profile.banks) ? profile.banks.length : 0,
      cards: Array.isArray(profile.cards) ? profile.cards.length : 0,
      categories: Array.isArray(profile.categories) ? profile.categories.length : 0,
      goals: Array.isArray(profile.goals) ? profile.goals.length : 0,
      debts: Array.isArray(profile.debts) ? profile.debts.length : 0,
      vaults: Array.isArray(profile.cofres) ? profile.cofres.length : 0,
      benefits: Array.isArray(profile.benefits) ? profile.benefits.length : 0,
      driverJourneys: Array.isArray(profile.uberJornadas) ? profile.uberJornadas.length : 0,
      driverRides: Array.isArray(profile.uberCorridas) ? profile.uberCorridas.length : 0,
      vehicles: Array.isArray(profile.uberVeiculos) ? profile.uberVeiculos.length : 0,
    },
    plan: { isPro: profile.isPro === true, proPlan: profile.proPlan || null },
  };
  if (name === 'get_financial_overview') return financialOverview(profile, args);
  if (name === 'search_transactions') {
    const { lookup, items } = collectTransactions(profile);
    const result = filterRecords(items, args).slice(0, args.limit || 50).map(record => publicRecord(record, lookup));
    return { matched: result.length, filters: args, items: result };
  }
  if (name === 'get_transaction_details') {
    const { lookup, items } = collectTransactions(profile);
    const record = items.find(item => String(item.id) === String(args.transactionId));
    return record ? { found: true, transaction: publicRecord(record, lookup) } : { found: false, error: 'Transação não encontrada.' };
  }
  if (name === 'get_account_activity') return getAccountActivity(profile, args);
  if (name === 'get_accounts_and_cards') return buildAccountsAndCards(profile);
  if (name === 'get_categories') {
    const { lookup, items } = collectTransactions(profile);
    return [...lookup.categories.values()].map(category => ({
      ...category,
      transactionCount: items.filter(item => item.category?.id === category.id).length,
      paidExpenseTotal: Number(items.filter(item => item.category?.id === category.id && item.countsAsSpending).reduce((sum, item) => sum + item.amount, 0).toFixed(2)),
    }));
  }
  if (name === 'get_planning') {
    const lookup = buildLookup(profile);
    return {
      goals: (Array.isArray(profile.goals) ? profile.goals : []).slice(0, 50).map(normalizeGoal),
      debts: (Array.isArray(profile.debts) ? profile.debts : []).slice(0, 50).map(debt => normalizeDebt(debt, lookup)),
      vaults: (Array.isArray(profile.cofres) ? profile.cofres : []).slice(0, 50).map(vault => normalizeVault(vault, lookup)),
    };
  }
  if (name === 'get_benefits') return benefitDetails(profile);
  if (name === 'get_driver_summary') return driverSummary(profile, args);
  if (name === 'get_user_memory') return { items: Array.isArray(profile.allofyMemory) ? profile.allofyMemory.slice(0, 30) : [] };
  if (name === 'save_user_memory') {
    if (!/(lembre|lembrar|guarde|memorize|não esqueça)/i.test(String(context.userMessage || ''))) {
      return { saved: 0, error: 'O usuário não pediu explicitamente para salvar uma memória.' };
    }
    const forbidden = /(senha|password|token|cvv|código de segurança|numero do cartão|número do cartão|chave privada)/i;
    const items = (args.items || []).map(item => String(item).trim().slice(0, 180)).filter(item => item.length >= 2 && !forbidden.test(item)).slice(0, 10);
    const existing = Array.isArray(profile.allofyMemory) ? profile.allofyMemory : [];
    const merged = [...new Set([...existing, ...items])].slice(-30);
    await database().collection('users').doc(uid).set({ allofyMemory: merged }, { merge: true });
    profile.allofyMemory = merged;
    return { saved: items.length, items: merged };
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

module.exports = {
  PERIODS,
  tools,
  executeAllofyTool,
  summarizeTransactions,
  periodRange,
  cleanTransaction,
  asNumber,
  currentMonthKey,
  calculateRegisteredCardPurchases,
  buildAccountsAndCards,
  buildMonthlyCommitments,
  buildAccountSnapshot,
  buildCommitmentAnalysis,
  buildLookup,
  collectTransactions,
  financialOverview,
  getAccountActivity,
};
