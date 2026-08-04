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
    const value = {
      id,
      name: bankDisplayName(bank),
      institution: bankInstitutionName(bank),
      type: safeText(bank?.type || bank?.tipo || 'corrente', 50),
      balance: asNumber(bank?.balance ?? bank?.saldo),
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
  return matchEntity(rawName, lookup?.bankSearch || [], ['name', 'institution']) || null;
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

function publicRecord(record) {
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
    coveredByBenefit: record.coveredByBenefit,
    isInvoicePayment: record.isInvoicePayment,
    installments: record.installments || null,
    installmentValue: record.installmentValue || null,
    hasInterest: record.hasInterest || false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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
  'cartao', 'cartao', 'credito', 'crédito', 'visa', 'mastercard', 'elo', 'amex',
  'nubank', 'inter', 'caixa', 'bradesco', 'itau', 'itaú', 'santander', 'c6',
  'principal', 'reserva', 'investimentos', 'investimento', 'platinum', 'gold', 'black',
]);

function entityText(entity = {}) {
  return normalizeText([
    entity.name, entity.nome, entity.accountName, entity.nickname, entity.apelido,
    entity.institution, entity.instituicao, entity.bankName, entity.bank,
    entity.creditor, entity.credor, entity.description, entity.descricao,
  ].filter(Boolean).join(' '));
}

function meaningfulOwnerTokens(bank = {}) {
  const institutionTokens = new Set(normalizeText(bank.institution).split(/[^a-z0-9]+/).filter(Boolean));
  return normalizeText(`${bank.name || ''} ${bank.institution || ''}`)
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 2 && !OWNER_STOPWORDS.has(token) && !institutionTokens.has(token));
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

function buildMonthlyCommitments(profile = {}, now = new Date()) {
  const month = currentMonthKey(now);
  const lookup = buildLookup(profile);
  const accountCardData = buildAccountsAndCards(profile, now);
  const cardsById = new Map(accountCardData.cards.map(card => [String(card.id || ''), card]));

  const openCardInvoices = (Array.isArray(profile.cards) ? profile.cards : []).map(rawCard => {
    const summary = cardsById.get(String(rawCard?.id || '')) || {};
    const account = inferAccountForEntity(rawCard, lookup);
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
    };
  }).filter(card => card.totalOpen > 0);

  const openDebts = (Array.isArray(profile.debts) ? profile.debts : []).map(rawDebt => {
    const debt = normalizeDebt(rawDebt, lookup);
    const account = debt.account || inferAccountForEntity(rawDebt, lookup, debt.payments);
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

  const byAccount = [...grouped.values()].map(bucket => ({
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
  const lines = [
    overviewPeriodLabel(overview.period, overview.range),
    '',
    'REALIZADO',
    `Receitas: ${formatBRL(overview.income)}`,
    `Despesas: ${formatBRL(overview.expenses)}`,
    `Saldo: ${formatBRL(overview.balance)}`,
  ];

  lines.push('', 'CONTAS A PAGAR E RECEBER');
  if (overview.pendingExpenses > 0) {
    lines.push(`Despesas pendentes: ${formatBRL(overview.pendingExpenses)} em ${overview.counts.pendingExpenses} lançamento(s)`);
  }
  if (overview.pendingIncome > 0) {
    lines.push(`Receitas pendentes: ${formatBRL(overview.pendingIncome)} em ${overview.counts.pendingIncome} lançamento(s)`);
  }
  if (overview.pendingExpenses <= 0 && overview.pendingIncome <= 0) {
    lines.push('Nenhuma pendência cadastrada para o período.');
  }

  for (const item of overview.pendingItems.slice(0, 8)) {
    const date = formatDateBR(item.date);
    const account = item.account?.name || item.card?.name || 'Sem conta vinculada';
    const prefix = [date, item.description].filter(Boolean).join(' · ');
    lines.push(`• ${prefix} · ${formatBRL(item.amount)} · ${account}`);
  }
  if (overview.pendingItems.length > 8) {
    lines.push(`• Mais ${overview.pendingItems.length - 8} pendência(s) no período.`);
  }

  lines.push('', `Saldo projetado após as transações pendentes: ${formatBRL(overview.projectedBalance)}`);

  if (complete) {
    lines.push('', 'FATURAS DE CARTÃO EM ABERTO');
    if (overview.commitments.openCardInvoices.length) {
      for (const card of overview.commitments.openCardInvoices.slice(0, 12)) {
        const due = card.dueDate ? ` · vence em ${formatDateBR(card.dueDate)}` : '';
        const owner = card.account?.name ? ` · ${card.account.name}` : '';
        lines.push(`• ${card.name}: ${formatBRL(card.totalOpen)}${due}${owner}`);
      }
      lines.push(`Total em faturas abertas: ${formatBRL(overview.commitments.totals.cardInvoicesOpen)}`);
    } else {
      lines.push('Nenhuma fatura aberta identificada para o mês atual.');
    }

    lines.push('', 'DÍVIDAS E FINANCIAMENTOS');
    if (overview.commitments.openDebts.length) {
      for (const debt of overview.commitments.openDebts.slice(0, 12)) {
        const due = debt.dueDate ? ` · vence em ${formatDateBR(debt.dueDate)}` : '';
        const owner = debt.account?.name ? ` · ${debt.account.name}` : '';
        lines.push(`• ${debt.name}: parcela em aberto ${formatBRL(debt.installmentOpen)} · saldo devedor ${formatBRL(debt.remaining)}${due}${owner}`);
      }
      lines.push(`Parcelas de dívidas ainda abertas no mês: ${formatBRL(overview.commitments.totals.debtInstallmentsOpen)}`);
      lines.push(`Saldo devedor total cadastrado: ${formatBRL(overview.commitments.totals.activeDebtBalance)}`);
    } else {
      lines.push('Nenhuma dívida ativa identificada.');
    }

    const cashCommitments = overview.pendingExpenses
      + overview.commitments.totals.cardInvoicesOpen
      + overview.commitments.totals.debtInstallmentsOpen;
    lines.push('', 'COMPROMISSOS DO MÊS');
    lines.push(`Contas pendentes + faturas abertas + parcelas de dívidas: ${formatBRL(cashCommitments)}`);
    lines.push('As faturas aparecem separadas das despesas para evitar contar a mesma compra duas vezes.');
  }

  if (overview.partialExpenses > 0 || overview.partialIncome > 0) {
    lines.push('', `Lançamentos parciais: receitas ${formatBRL(overview.partialIncome)} e despesas ${formatBRL(overview.partialExpenses)}.`);
  }

  return lines.join('\n');
}

function buildCompleteByAccountResponse(overview) {
  const groups = new Map();

  for (const account of overview.byAccount || []) {
    if (!account || account.totalRecords <= 0) continue;
    groups.set(account.key, {
      key: account.key,
      name: account.name,
      institution: account.institution,
      paidIncome: account.paidIncome,
      paidExpenses: account.paidExpenses,
      realizedBalance: account.realizedBalance,
      pendingIncome: account.pendingIncome,
      pendingExpenses: account.pendingExpenses,
      cards: [], debts: [],
    });
  }

  for (const commitment of overview.commitments?.byAccount || []) {
    const current = groups.get(commitment.key) || {
      key: commitment.key,
      name: commitment.name,
      institution: commitment.institution,
      paidIncome: 0,
      paidExpenses: 0,
      realizedBalance: 0,
      pendingIncome: 0,
      pendingExpenses: 0,
      cards: [], debts: [],
    };
    current.cards = commitment.cards || [];
    current.debts = commitment.debts || [];
    groups.set(commitment.key, current);
  }

  const pendingByKey = new Map();
  for (const item of overview.pendingItems || []) {
    const key = item.account?.id || (item.card?.id ? `card:${item.card.id}` : '__sem_conta__');
    const list = pendingByKey.get(key) || [];
    list.push(item);
    pendingByKey.set(key, list);
  }

  const lines = [overviewPeriodLabel(overview.period, overview.range), ''];
  const ordered = [...groups.values()].sort((a, b) => {
    const totalA = a.paidIncome + a.paidExpenses + a.pendingIncome + a.pendingExpenses
      + a.cards.reduce((sum, card) => sum + card.totalOpen, 0)
      + a.debts.reduce((sum, debt) => sum + debt.installmentOpen, 0);
    const totalB = b.paidIncome + b.paidExpenses + b.pendingIncome + b.pendingExpenses
      + b.cards.reduce((sum, card) => sum + card.totalOpen, 0)
      + b.debts.reduce((sum, debt) => sum + debt.installmentOpen, 0);
    return totalB - totalA;
  });

  for (const group of ordered) {
    lines.push(String(group.name || 'Sem conta vinculada').toLocaleUpperCase('pt-BR'));
    lines.push(`Realizado: receitas ${formatBRL(group.paidIncome)} · despesas ${formatBRL(group.paidExpenses)} · saldo ${formatBRL(group.realizedBalance)}`);

    if (group.pendingExpenses > 0 || group.pendingIncome > 0) {
      lines.push(`Pendências: despesas ${formatBRL(group.pendingExpenses)} · receitas ${formatBRL(group.pendingIncome)}`);
      for (const item of (pendingByKey.get(group.key) || []).slice(0, 8)) {
        lines.push(`• ${formatDateBR(item.date)} · ${item.description} · ${formatBRL(item.amount)}`);
      }
    } else {
      lines.push('Pendências: nenhuma transação pendente.');
    }

    if (group.cards.length) {
      lines.push('Faturas abertas:');
      for (const card of group.cards.slice(0, 8)) {
        const due = card.dueDate ? ` · vence em ${formatDateBR(card.dueDate)}` : '';
        lines.push(`• ${card.name} · ${formatBRL(card.totalOpen)}${due}`);
      }
    }

    if (group.debts.length) {
      lines.push('Dívidas e financiamentos:');
      for (const debt of group.debts.slice(0, 8)) {
        const due = debt.dueDate ? ` · vence em ${formatDateBR(debt.dueDate)}` : '';
        lines.push(`• ${debt.name} · parcela aberta ${formatBRL(debt.installmentOpen)} · saldo devedor ${formatBRL(debt.remaining)}${due}`);
      }
    }
    lines.push('');
  }

  lines.push('TOTAL DO MÊS');
  lines.push(`Realizado: receitas ${formatBRL(overview.income)} · despesas ${formatBRL(overview.expenses)} · saldo ${formatBRL(overview.balance)}`);
  lines.push(`Transações pendentes: ${formatBRL(overview.pendingExpenses)} em despesas e ${formatBRL(overview.pendingIncome)} em receitas`);
  lines.push(`Faturas abertas: ${formatBRL(overview.commitments?.totals?.cardInvoicesOpen || 0)}`);
  lines.push(`Parcelas de dívidas em aberto: ${formatBRL(overview.commitments?.totals?.debtInstallmentsOpen || 0)}`);
  lines.push(`Saldo devedor total das dívidas: ${formatBRL(overview.commitments?.totals?.activeDebtBalance || 0)}`);
  lines.push('Faturas e parcelas aparecem separadas para não duplicar gastos já registrados.');
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
    : { month: requestedMonth, openCardInvoices: [], openDebts: [], byAccount: [], totals: { cardInvoicesOpen: 0, debtInstallmentsOpen: 0, activeDebtBalance: 0 } };

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
      key: record.category?.id || record.category?.name || 'outros',
      name: record.category?.name || 'Outros',
      emoji: record.category?.emoji || '🏷️',
    })),
    pendingByCategory: aggregate(pendingExpenseRecords, record => ({
      key: record.category?.id || record.category?.name || 'outros',
      name: record.category?.name || 'Outros',
      emoji: record.category?.emoji || '🏷️',
    })),
    byAccount: accountBreakdown,
    paidByAccount: aggregate([...paidIncome, ...paidExpenses], record => {
      const descriptor = accountDescriptor(record);
      return {
        key: descriptor.key,
        name: descriptor.name,
        institution: descriptor.institution,
        unassigned: descriptor.unassigned,
      };
    }),
    pendingByAccount: accountBreakdown
      .filter(account => account.pendingIncome > 0 || account.pendingExpenses > 0)
      .map(account => ({
        key: account.key,
        id: account.id,
        name: account.name,
        institution: account.institution,
        unassigned: account.unassigned,
        pendingIncome: account.pendingIncome,
        pendingExpenses: account.pendingExpenses,
        pendingRecords: account.pendingRecords,
      })),
    byCard: aggregate(paidExpenses.filter(record => record.card), record => ({
      key: record.card.id,
      name: record.card.name,
      brand: record.card.brand,
    })),
    pendingItems: orderedPending.slice(0, 30).map(compactFinancialRecord),
    partialItems: sortPendingRecords(partial).slice(0, 20).map(compactFinancialRecord),
    recentPaidExpenses: [...paidExpenses]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 10)
      .map(compactFinancialRecord),
    commitmentsApplicable,
    commitments,
  };

  overview.suggestedResponse = buildSuggestedOverviewResponse(overview, false);
  overview.suggestedCompleteResponse = buildSuggestedOverviewResponse(overview, true);
  overview.suggestedCompleteByAccountResponse = buildCompleteByAccountResponse(overview);
  overview.responseGuidance = {
    broadSummary: 'Para pedidos simples como "resumo do mês atual", use suggestedResponse como base.',
    completeSummary: 'Quando o usuário pedir resumo completo, detalhado, tudo do mês ou separar Gui/Luh, use suggestedCompleteByAccountResponse como base; os dados também estão em commitments.byAccount, byAccount e pendingByAccount. Inclua faturas abertas e dívidas ativas.',
    pending: 'Quando houver pendências, sempre informe o total, a quantidade e os itens disponíveis em pendingItems, incluindo a conta quando existir.',
    accounts: 'Nunca diga que pendências não podem ser separadas por conta; use pendingByAccount. Para faturas e dívidas, use commitments.byAccount. Quando account for nulo, diga apenas "Sem conta vinculada".',
    exclusions: 'Transferências, benefícios cobertos e pagamentos de fatura foram excluídos dos gastos realizados para evitar dupla contagem. Faturas abertas devem aparecer como compromisso, não como nova despesa.',
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
    description: 'Calcula o resumo financeiro do período e, no mês atual, inclui contas pendentes, faturas de cartão em aberto, parcelas e saldo de dívidas, com agrupamento por conta/pessoa. Use suggestedResponse para resumo simples e suggestedCompleteResponse para pedidos completos ou detalhados. Exclui transferências, benefícios cobertos e pagamento de fatura dos gastos realizados para evitar dupla contagem.',
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
  const snap = await database().collection('users').doc(uid).get();
  if (!snap.exists) throw new Error('Perfil financeiro não encontrado');
  return snap.data() || {};
}

function appCapabilities() {
  return {
    app: 'Allo Finanças',
    access: 'Somente leitura para o Allofy',
    modules: [
      { name: 'Início', capabilities: ['resumo mensal', 'saldo', 'receitas', 'despesas', 'últimas movimentações'] },
      { name: 'Extrato', capabilities: ['receitas e despesas', 'status pago/pendente', 'data', 'categoria', 'conta bancária', 'cartão', 'benefício', 'recorrência', 'observações', 'transferências'] },
      { name: 'Contas bancárias', capabilities: ['múltiplas contas', 'apelido e instituição', 'saldo', 'tipo', 'extrato por conta', 'transferências', 'conciliações de saldo'] },
      { name: 'Cartões', capabilities: ['compras', 'parcelas', 'juros', 'categoria', 'data da compra', 'fatura manual ou calculada', 'pagamentos', 'limite'] },
      { name: 'Relatórios', capabilities: ['7 e 30 dias', 'mês', 'ano', 'personalizado', 'categoria', 'origem dos gastos', 'insights'] },
      { name: 'Planejamento', capabilities: ['metas', 'dívidas', 'cofres', 'orçamentos por categoria'] },
      { name: 'Benefícios', capabilities: ['VA/VR/combustível', 'usos e saldo restante'] },
      { name: 'Motorista', capabilities: ['jornadas', 'corridas', 'receitas', 'gastos', 'abastecimentos', 'veículos'] },
      { name: 'Allofy', capabilities: ['pesquisa detalhada', 'resumos', 'comparações', 'filtros por data, conta, cartão, categoria e status'] },
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
    const { items } = collectTransactions(profile);
    const result = filterRecords(items, args).slice(0, args.limit || 50).map(publicRecord);
    return { matched: result.length, filters: args, items: result };
  }
  if (name === 'get_transaction_details') {
    const { items } = collectTransactions(profile);
    const record = items.find(item => String(item.id) === String(args.transactionId));
    return record ? { found: true, transaction: publicRecord(record) } : { found: false, error: 'Transação não encontrada.' };
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
  buildLookup,
  collectTransactions,
  financialOverview,
  getAccountActivity,
};
