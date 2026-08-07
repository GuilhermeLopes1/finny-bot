const crypto = require('crypto');
const { getDb, admin } = require('../config/firebase');
const { hydrateProfile } = require('./v39ProfileService');

const ACTION_LOG_COLLECTION = 'allofy_action_logs';
const ACTION_VERSION = 1;
const MAX_AUDIT_OPERATIONS = 12;

function nowIso() { return new Date().toISOString(); }
function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function text(value, max = 180) { return String(value ?? '').trim().slice(0, max); }
function normalize(value) {
  return text(value, 240).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}
function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function newId(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`; }
function userRef(uid) { return getDb().collection('users').doc(uid); }
function itemRef(uid, collection, id) { return userRef(uid).collection(collection).doc(String(id)); }
function actionLogRef(uid, actionId) { return userRef(uid).collection(ACTION_LOG_COLLECTION).doc(actionId); }
function requestActionId(requestId = '') {
  const value = text(requestId, 300);
  if (!value) return newId('action');
  return `action_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}
function publicDocPath(ref, uid) {
  const p = ref.path;
  if (!p.startsWith(`users/${uid}/`)) throw new Error('Caminho de escrita fora do usuário atual.');
  return p;
}
function cloneData(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}
function resultError(code, message, extra = {}) { return { ok: false, code, error: message, ...extra }; }
function mutationResult(action, actionId, summary, extra = {}) {
  return { ok: true, mutated: true, action, actionId, undoable: true, summary, ...extra };
}

async function freshProfile(uid) {
  return hydrateProfile(uid);
}

function uniqueMatch(query, items, fields) {
  const q = normalize(query);
  if (!q) return { item: null, matches: [] };
  const idMatch = items.find(item => String(item.id || '') === String(query));
  if (idMatch) return { item: idMatch, matches: [idMatch] };

  // Campos opcionais ausentes viram string vazia. Antes, q.includes('') era true
  // e fazia itens sem um dos aliases (ex.: categoria sem `nome`) parecerem match.
  const normalizedValues = item => fields.map(field => normalize(item?.[field])).filter(Boolean);
  const exact = items.filter(item => normalizedValues(item).some(value => value === q));
  if (exact.length === 1) return { item: exact[0], matches: exact };
  if (exact.length > 1) return { item: null, matches: exact };
  const partial = items.filter(item => normalizedValues(item).some(value => value.includes(q) || q.includes(value)));
  return { item: partial.length === 1 ? partial[0] : null, matches: partial };
}

function bankLabel(bank = {}) { return text(bank.accountName || bank.nickname || bank.apelido || bank.name || bank.institution || 'Conta', 100); }
function cardLabel(card = {}) { return text(card.name || card.nome || card.brand || 'Cartão', 100); }
function categoryLabel(category = {}) { return text(category.name || category.nome || 'Outros', 100); }

// V44.2 — linguagem natural -> categorias padrão/cadastradas.
// Evita falhar uma compra só porque a IA disse "Comida" e a categoria
// cadastrada se chama "Alimentação", por exemplo.
const CATEGORY_FAMILIES = {
  alimentacao: ['alimentacao','comida','refeicao','lanche','salgado','padaria','mercado','supermercado','restaurante','delivery','ifood','pizza','cafe','cafeteria'],
  transporte: ['transporte','uber','99','taxi','onibus','metro','combustivel','gasolina','etanol','diesel','posto','pedagio','estacionamento'],
  moradia: ['moradia','casa','aluguel','condominio','iptu','energia','luz','agua','gas','internet'],
  saude: ['saude','farmacia','remedio','medico','dentista','hospital','clinica','exame','psicologo','psicologa'],
  educacao: ['educacao','escola','faculdade','curso','livro','material escolar','mensalidade'],
  lazer: ['lazer','cinema','jogo','games','netflix','spotify','show','entretenimento'],
  salario: ['salario','renda','pagamento','adiantamento','freela','freelance','comissao'],
  investimentos: ['investimentos','investimento','aporte','dividendo','cdb','tesouro','acao','acoes','fundo'],
  outros: ['outros','outro','diversos','diverso'],
};

function categoryFamily(value) {
  const q = normalize(value);
  if (!q) return '';
  for (const [family, aliases] of Object.entries(CATEGORY_FAMILIES)) {
    if (aliases.some(alias => q === alias || q.includes(alias))) return family;
  }
  return '';
}

function categoryKindMatches(category, kind = '') {
  if (!kind) return true;
  const raw = normalize(category?.kind || category?.type || category?.tipo);
  if (!raw || raw === 'both' || raw === 'ambos') return true;
  if (kind === 'income') return ['income','receita','renda'].includes(raw);
  return ['expense','despesa','gasto'].includes(raw);
}

function resolveBank(profile, query, required = false) {
  if (!query) return required ? resultError('bank_required', 'Informe qual conta bancária deve ser usada.') : { ok: true, item: null };
  const { item, matches } = uniqueMatch(query, profile.banks || [], ['name', 'institution', 'accountName', 'nickname', 'apelido']);
  if (item) return { ok: true, item };
  if (matches.length > 1) return resultError('bank_ambiguous', 'Encontrei mais de uma conta compatível. Diga o apelido ou nome exato da conta.', { choices: matches.slice(0, 8).map(b => ({ id: b.id, name: bankLabel(b), institution: b.institution || null, balance: money(b.balance) })) });
  return resultError('bank_not_found', `Não encontrei a conta “${text(query, 80)}”.`);
}

function resolveCard(profile, query, required = false) {
  if (!query) return required ? resultError('card_required', 'Informe qual cartão deve ser usado.') : { ok: true, item: null };
  const { item, matches } = uniqueMatch(query, profile.cards || [], ['name', 'brand', 'last4', 'final']);
  if (item) return { ok: true, item };
  if (matches.length > 1) return resultError('card_ambiguous', 'Encontrei mais de um cartão compatível. Diga o nome ou final do cartão.', { choices: matches.slice(0, 8).map(c => ({ id: c.id, name: cardLabel(c), last4: c.last4 || c.final || null })) });
  return resultError('card_not_found', `Não encontrei o cartão “${text(query, 80)}”.`);
}

function resolveCategory(profile, query, kind = '', description = '') {
  const categories = Array.isArray(profile.categories) ? profile.categories : [];
  if (!query && !description) return { ok: true, item: null };

  // 1) Nome/ID informado pelo usuário ou pela IA tem prioridade.
  if (query) {
    const { item, matches } = uniqueMatch(query, categories, ['name', 'nome']);
    if (item && categoryKindMatches(item, kind)) return { ok: true, item };
    const compatibleMatches = matches.filter(category => categoryKindMatches(category, kind));
    if (compatibleMatches.length === 1) return { ok: true, item: compatibleMatches[0] };
    if (compatibleMatches.length > 1) return resultError('category_ambiguous', 'Encontrei mais de uma categoria parecida. Diga o nome exato.', { choices: compatibleMatches.slice(0, 8).map(c => ({ id: c.id, name: categoryLabel(c) })) });
  }

  // 2) Aceita sinônimos naturais. Ex.: Comida/Salgado -> Alimentação.
  const family = categoryFamily(query) || categoryFamily(description);
  if (family) {
    const familyMatches = categories.filter(category =>
      categoryKindMatches(category, kind) && categoryFamily(categoryLabel(category)) === family
    );
    if (familyMatches.length === 1) return { ok: true, item: familyMatches[0], normalizedFrom: text(query || description, 80) };
    if (familyMatches.length > 1) return resultError('category_ambiguous', 'Encontrei mais de uma categoria compatível. Diga qual delas deve ser usada.', { choices: familyMatches.slice(0, 8).map(c => ({ id: c.id, name: categoryLabel(c) })) });
  }

  // Categoria continua opcional quando a frase não informa nenhuma.
  if (!query) return { ok: true, item: null };
  return resultError('category_not_found', `Não encontrei uma categoria cadastrada compatível com “${text(query, 80)}”. Diga o nome da categoria que deseja usar.` , { suggestedKind: kind || null });
}

function resolveGoal(profile, query) {
  const { item, matches } = uniqueMatch(query, profile.goals || [], ['name', 'description']);
  if (item) return { ok: true, item };
  if (matches.length > 1) return resultError('goal_ambiguous', 'Encontrei mais de uma meta parecida. Diga o nome exato.', { choices: matches.slice(0, 8).map(g => ({ id: g.id, name: g.name })) });
  return resultError('goal_not_found', `Não encontrei a meta “${text(query, 80)}”.`);
}

function resolveDebt(profile, query) {
  const { item, matches } = uniqueMatch(query, profile.debts || [], ['name', 'nome']);
  if (item) return { ok: true, item };
  if (matches.length > 1) return resultError('debt_ambiguous', 'Encontrei mais de uma dívida parecida. Diga o nome exato.', { choices: matches.slice(0, 8).map(d => ({ id: d.id, name: d.name })) });
  return resultError('debt_not_found', `Não encontrei a dívida “${text(query, 80)}”.`);
}

function normalizeSource(source) {
  return ['text', 'voice', 'live', 'widget', 'widget_live'].includes(String(source)) ? String(source) : 'text';
}

async function performAction({ uid, action, requestId, source, refs, compute }) {
  const db = getDb();
  const actionId = requestActionId(requestId);
  const logRef = actionLogRef(uid, actionId);
  const uniqueRefs = [...new Map(refs.map(ref => [ref.path, ref])).values()];
  return db.runTransaction(async tx => {
    const logSnap = await tx.get(logRef);
    if (logSnap.exists) {
      const previous = logSnap.data() || {};
      return { ...(previous.result || { ok: true }), idempotentReplay: true };
    }
    const snaps = await Promise.all(uniqueRefs.map(ref => tx.get(ref)));
    const byPath = new Map(snaps.map((snap, index) => [uniqueRefs[index].path, snap]));
    const planned = await compute(byPath);
    if (!planned?.ok) return planned;
    const writes = (planned.writes || []).slice(0, MAX_AUDIT_OPERATIONS);
    const auditOps = [];
    for (const write of writes) {
      const path = publicDocPath(write.ref, uid);
      const beforeSnap = byPath.get(path);
      const before = beforeSnap?.exists ? cloneData(beforeSnap.data()) : null;
      if (write.type === 'delete') {
        tx.delete(write.ref);
        auditOps.push({ path, type: 'delete', before, after: null });
      } else {
        const after = cloneData(write.data);
        tx.set(write.ref, write.data, { merge: write.merge === true });
        // For merge updates, store a full replayable post-state when possible.
        const mergedAfter = write.merge && before ? { ...before, ...after } : after;
        auditOps.push({ path, type: 'set', before, after: mergedAfter });
      }
    }
    const result = { ...planned.result, actionId };
    tx.set(logRef, {
      version: ACTION_VERSION,
      action,
      source: normalizeSource(source),
      requestIdHash: requestId ? crypto.createHash('sha256').update(String(requestId)).digest('hex') : null,
      operations: auditOps,
      result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtIso: nowIso(),
      undoneAt: null,
    });
    return result;
  });
}

function docDataWithOrder(data) { return { ...data, _v39Order: Date.now() }; }

async function createTransaction(uid, args, context) {
  const profile = await freshProfile(uid);
  const type = args.type === 'income' ? 'income' : 'expense';
  const amount = money(args.amount);
  if (!(amount > 0)) return resultError('invalid_amount', 'Informe um valor maior que zero.');
  const description = text(args.description, 160);
  if (!description) return resultError('description_required', 'Informe uma descrição para o lançamento.');
  const bankResult = resolveBank(profile, args.account, false); if (!bankResult.ok) return bankResult;
  const categoryResult = resolveCategory(profile, args.category, type, description); if (!categoryResult.ok && args.category) return categoryResult;
  const bank = bankResult.item;
  const category = categoryResult.item;
  const status = ['paid', 'pending'].includes(args.status) ? args.status : 'paid';
  const recurrence = ['fixed', 'variable', 'installment'].includes(args.recurrence) ? args.recurrence : 'variable';
  const date = validDate(args.date) ? args.date : todaySaoPaulo();
  const id = newId('tx_ai');
  const createdAt = nowIso();
  const txData = docDataWithOrder({
    id, desc: description, description, amount, date, type,
    category: category?.id || text(args.category, 100) || '',
    bankId: bank?.id || null, cardId: null, benefitId: null, coveredByBenefit: false,
    status, recurrence, notes: text(args.notes, 500), source: 'allofy', allofyCreated: true,
    createdAt, updatedAt: createdAt,
  });
  const refs = [itemRef(uid, 'transactions', id)];
  if (bank) refs.push(itemRef(uid, 'banks', bank.id));
  return performAction({
    uid, action: 'create_transaction', requestId: context.requestId, source: context.source, refs,
    compute: byPath => {
      const writes = [{ type: 'set', ref: itemRef(uid, 'transactions', id), data: txData }];
      if (bank && status === 'paid') {
        const bankRef = itemRef(uid, 'banks', bank.id);
        const bankSnap = byPath.get(bankRef.path);
        if (!bankSnap?.exists) return resultError('bank_not_found', 'A conta bancária deixou de existir.');
        const current = bankSnap.data() || {};
        const balance = money(current.balance);
        if (type === 'expense' && balance + 0.001 < amount) return resultError('insufficient_balance', `Saldo insuficiente em ${bankLabel(current)}.`, { balance });
        const newBalance = money(balance + (type === 'income' ? amount : -amount));
        writes.push({ type: 'set', ref: bankRef, merge: true, data: { balance: newBalance, updatedAt: createdAt } });
      }
      const summary = `${type === 'income' ? 'Receita' : 'Despesa'} de R$ ${amount.toFixed(2).replace('.', ',')} registrada: ${description}.`;
      return { ok: true, writes, result: mutationResult('create_transaction', null, summary, { entity: { kind: 'transaction', id }, refresh: ['transactions', ...(bank ? ['banks'] : [])] }) };
    },
  });
}

async function createCardPurchase(uid, args, context) {
  const profile = await freshProfile(uid);
  const cardResult = resolveCard(profile, args.card, true); if (!cardResult.ok) return cardResult;
  const categoryResult = resolveCategory(profile, args.category, 'expense', args.description); if (!categoryResult.ok && args.category) return categoryResult;
  const card = cardResult.item;
  const category = categoryResult.item;
  const amount = money(args.amount);
  const installments = Math.max(1, Math.min(60, Number(args.installments || 1) | 0));
  if (!(amount > 0)) return resultError('invalid_amount', 'Informe um valor maior que zero.');
  const description = text(args.description, 160);
  if (!description) return resultError('description_required', 'Informe uma descrição para a compra.');
  const installmentAmount = args.installmentAmount && money(args.installmentAmount) > 0 ? money(args.installmentAmount) : money(amount / installments);
  const finalAmount = money(installmentAmount * installments);
  const interestTotal = money(Math.max(0, finalAmount - amount));
  const id = newId('card_ai');
  const created = Date.now();
  const data = docDataWithOrder({
    id, cardId: card.id, descricao: description, valorTotal: amount, parcelas: installments,
    valorParcela: installmentAmount, valorFinal: finalAmount, jurosTotal: interestTotal,
    temJuros: interestTotal > 0, categoria: category?.name || text(args.category, 100) || '',
    dataCompra: validDate(args.date) ? args.date : todaySaoPaulo(), obs: text(args.notes, 500),
    tipo: 'credito', source: 'allofy', allofyCreated: true, createdAt: created, updatedAt: created,
  });
  const ref = itemRef(uid, 'cardTransactions', id);
  return performAction({
    uid, action: 'create_card_purchase', requestId: context.requestId, source: context.source, refs: [ref],
    compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_card_purchase', null, `Compra de R$ ${amount.toFixed(2).replace('.', ',')} registrada no cartão ${cardLabel(card)}.`, { entity: { kind: 'card_purchase', id }, refresh: ['cardTransactions', 'cards'] }) }),
  });
}

async function recordTransfer(uid, args, context) {
  const profile = await freshProfile(uid);
  const fromResult = resolveBank(profile, args.fromAccount, true); if (!fromResult.ok) return fromResult;
  const toResult = resolveBank(profile, args.toAccount, true); if (!toResult.ok) return toResult;
  const from = fromResult.item; const to = toResult.item;
  if (from.id === to.id) return resultError('same_account', 'Escolha duas contas diferentes.');
  const amount = money(args.amount); if (!(amount > 0)) return resultError('invalid_amount', 'Informe um valor maior que zero.');
  const date = validDate(args.date) ? args.date : todaySaoPaulo();
  const description = text(args.description, 120) || 'Transferência';
  const group = newId('tr_ai'); const outId = newId('tx_ai'); const inId = newId('tx_ai'); const at = nowIso();
  const fromRef = itemRef(uid, 'banks', from.id); const toRef = itemRef(uid, 'banks', to.id);
  const outRef = itemRef(uid, 'transactions', outId); const inRef = itemRef(uid, 'transactions', inId);
  const common = { amount, date, category: '', status: 'paid', recurrence: 'variable', notes: 'Transferência entre contas registrada pelo Allofy', isTransfer: true, transferGroupId: group, source: 'allofy', allofyCreated: true, createdAt: at, updatedAt: at };
  return performAction({
    uid, action: 'record_transfer', requestId: context.requestId, source: context.source, refs: [fromRef, toRef, outRef, inRef],
    compute: byPath => {
      const f = byPath.get(fromRef.path)?.data(); const t = byPath.get(toRef.path)?.data();
      if (!f || !t) return resultError('bank_not_found', 'Uma das contas não existe mais.');
      const fromBalance = money(f.balance); if (fromBalance + 0.001 < amount) return resultError('insufficient_balance', `Saldo insuficiente em ${bankLabel(f)}.`, { balance: fromBalance });
      const writes = [
        { type: 'set', ref: fromRef, merge: true, data: { balance: money(fromBalance - amount), updatedAt: at } },
        { type: 'set', ref: toRef, merge: true, data: { balance: money(t.balance + amount), updatedAt: at } },
        { type: 'set', ref: outRef, data: docDataWithOrder({ id: outId, description: `${description} → ${bankLabel(t)}`, desc: `${description} → ${bankLabel(t)}`, type: 'expense', bankId: from.id, ...common }) },
        { type: 'set', ref: inRef, data: docDataWithOrder({ id: inId, description: `${description} ← ${bankLabel(f)}`, desc: `${description} ← ${bankLabel(f)}`, type: 'income', bankId: to.id, ...common }) },
      ];
      return { ok: true, writes, result: mutationResult('record_transfer', null, `Transferência de R$ ${amount.toFixed(2).replace('.', ',')} registrada de ${bankLabel(f)} para ${bankLabel(t)}. Isso registra o movimento no Allofy; não movimenta dinheiro no banco.`, { entity: { kind: 'transfer', id: group }, refresh: ['transactions', 'banks'] }) };
    },
  });
}

async function createGoal(uid, args, context) {
  const name = text(args.name, 120); const target = money(args.target);
  if (!name) return resultError('name_required', 'Informe o nome da meta.');
  if (!(target > 0)) return resultError('invalid_target', 'Informe um valor-alvo maior que zero.');
  const current = Math.max(0, Math.min(target, money(args.current || 0)));
  const id = newId('goal_ai'); const at = nowIso();
  const data = docDataWithOrder({ id, name, description: text(args.description, 300), target, current, monthlyContribution: Math.max(0, money(args.monthlyContribution || 0)), deadline: validDate(args.deadline) ? args.deadline : '', status: current >= target ? 'completed' : 'active', color: text(args.color, 20) || '#7c3aed', icon: text(args.icon, 8) || '🎯', order: Date.now(), history: [], createdAt: at, updatedAt: at, completedAt: current >= target ? at : null, source: 'allofy', allofyCreated: true });
  const ref = itemRef(uid, 'goals', id);
  return performAction({ uid, action: 'create_goal', requestId: context.requestId, source: context.source, refs: [ref], compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_goal', null, `Meta “${name}” criada com objetivo de R$ ${target.toFixed(2).replace('.', ',')}.`, { entity: { kind: 'goal', id }, refresh: ['goals'] }) }) });
}

async function addGoalProgress(uid, args, context) {
  const profile = await freshProfile(uid); const goalResult = resolveGoal(profile, args.goal); if (!goalResult.ok) return goalResult;
  const amount = money(args.amount); if (!(amount > 0)) return resultError('invalid_amount', 'Informe quanto deseja adicionar à meta.');
  const goal = goalResult.item; const ref = itemRef(uid, 'goals', goal.id); const at = nowIso();
  return performAction({ uid, action: 'add_goal_progress', requestId: context.requestId, source: context.source, refs: [ref], compute: byPath => {
    const currentDoc = byPath.get(ref.path)?.data(); if (!currentDoc) return resultError('goal_not_found', 'A meta deixou de existir.');
    const target = money(currentDoc.target); const before = money(currentDoc.current); const next = Math.min(target || Infinity, money(before + amount));
    const history = Array.isArray(currentDoc.history) ? currentDoc.history.slice(-99) : [];
    history.push({ id: newId('goalhist'), amount, date: todaySaoPaulo(), note: text(args.note, 180) || 'Progresso registrado pelo Allofy', createdAt: at });
    const data = { current: next, history, status: target > 0 && next >= target ? 'completed' : (currentDoc.status || 'active'), completedAt: target > 0 && next >= target ? (currentDoc.completedAt || at) : null, updatedAt: at };
    return { ok: true, writes: [{ type: 'set', ref, merge: true, data }], result: mutationResult('add_goal_progress', null, `Adicionei R$ ${amount.toFixed(2).replace('.', ',')} à meta “${currentDoc.name || goal.name}”.`, { entity: { kind: 'goal', id: goal.id }, refresh: ['goals'] }) };
  } });
}

async function createDebt(uid, args, context) {
  const name = text(args.name, 120); const total = money(args.total); if (!name) return resultError('name_required', 'Informe o nome da dívida.'); if (!(total > 0)) return resultError('invalid_total', 'Informe o valor total da dívida.');
  const paid = Math.max(0, Math.min(total, money(args.paid || 0))); const installment = Math.max(0, money(args.installment || 0)); const id = newId('debt_ai'); const at = nowIso();
  const data = docDataWithOrder({ id, name, icon: text(args.icon, 8) || '💳', total, paid, installment, installmentsTotal: Math.max(0, Number(args.installmentsTotal || 0) | 0), installmentsPaid: installment > 0 ? Math.min(Math.floor((paid + 0.005) / installment), Math.max(0, Number(args.installmentsTotal || 0) | 0) || Infinity) : 0, startDate: validDate(args.startDate) ? args.startDate : todaySaoPaulo(), dueDay: Math.max(1, Math.min(31, Number(args.dueDay || 1) | 0)), status: paid >= total ? 'paid' : 'pending', createdAt: at, updatedAt: at, payments: [], source: 'allofy', allofyCreated: true });
  const ref = itemRef(uid, 'debts', id);
  return performAction({ uid, action: 'create_debt', requestId: context.requestId, source: context.source, refs: [ref], compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_debt', null, `Dívida “${name}” cadastrada com valor total de R$ ${total.toFixed(2).replace('.', ',')}.`, { entity: { kind: 'debt', id }, refresh: ['debts'] }) }) });
}

async function recordDebtPayment(uid, args, context) {
  const profile = await freshProfile(uid); const debtResult = resolveDebt(profile, args.debt); if (!debtResult.ok) return debtResult; const debt = debtResult.item;
  const amount = money(args.amount); if (!(amount > 0)) return resultError('invalid_amount', 'Informe o valor pago.');
  const bankResult = resolveBank(profile, args.account, false); if (!bankResult.ok) return bankResult; const bank = bankResult.item;
  const debtRef = itemRef(uid, 'debts', debt.id); const txId = newId('tx_debt_ai'); const txRef = itemRef(uid, 'transactions', txId); const refs = [debtRef, txRef]; if (bank) refs.push(itemRef(uid, 'banks', bank.id)); const at = nowIso(); const date = validDate(args.date) ? args.date : todaySaoPaulo();
  return performAction({ uid, action: 'record_debt_payment', requestId: context.requestId, source: context.source, refs, compute: byPath => {
    const d = byPath.get(debtRef.path)?.data(); if (!d) return resultError('debt_not_found', 'A dívida deixou de existir.'); const remaining = Math.max(0, money(d.total) - money(d.paid)); if (amount > remaining + 0.005) return resultError('payment_too_high', 'O pagamento é maior que o saldo devedor.', { remaining });
    const writes = []; if (bank) { const bRef = itemRef(uid, 'banks', bank.id); const b = byPath.get(bRef.path)?.data(); if (!b) return resultError('bank_not_found', 'A conta deixou de existir.'); const balance = money(b.balance); if (balance + 0.001 < amount) return resultError('insufficient_balance', `Saldo insuficiente em ${bankLabel(b)}.`, { balance }); writes.push({ type: 'set', ref: bRef, merge: true, data: { balance: money(balance - amount), updatedAt: at } }); }
    const nextPaid = Math.min(money(d.total), money(money(d.paid) + amount)); const payments = Array.isArray(d.payments) ? d.payments.slice(-199) : []; payments.push({ id: newId('debtpay_ai'), amount, date, bankId: bank?.id || null, createdAt: at, source: 'allofy' });
    const installment = money(d.installment); const installmentsPaid = installment > 0 ? Math.min(Math.floor((nextPaid + 0.005) / installment), Number(d.installmentsTotal || 0) || Infinity) : Number(d.installmentsPaid || 0);
    writes.push({ type: 'set', ref: debtRef, merge: true, data: { paid: nextPaid, payments, installmentsPaid, status: nextPaid >= money(d.total) ? 'paid' : 'pending', updatedAt: at } });
    writes.push({ type: 'set', ref: txRef, data: docDataWithOrder({ id: txId, type: 'expense', amount, desc: `Pagamento: ${d.name || debt.name}`, description: `Pagamento: ${d.name || debt.name}`, category: 'Dívidas', date, status: 'paid', recurrence: 'variable', bankId: bank?.id || null, debtId: debt.id, source: 'allofy', allofyCreated: true, createdAt: at, updatedAt: at }) });
    return { ok: true, writes, result: mutationResult('record_debt_payment', null, `Pagamento de R$ ${amount.toFixed(2).replace('.', ',')} registrado na dívida “${d.name || debt.name}”.`, { entity: { kind: 'debt_payment', id: txId }, refresh: ['debts', 'transactions', ...(bank ? ['banks'] : [])] }) };
  } });
}

async function createCategory(uid, args, context) {
  const profile = await freshProfile(uid); const name = text(args.name, 100); if (!name) return resultError('name_required', 'Informe o nome da categoria.');
  const existing = uniqueMatch(name, profile.categories || [], ['name', 'nome']); if (existing.item) return resultError('category_exists', `A categoria “${categoryLabel(existing.item)}” já existe.`, { id: existing.item.id });
  const id = newId('cat_ai'); const at = nowIso(); const data = docDataWithOrder({ id, name, description: text(args.description, 220), kind: ['income', 'expense', 'both'].includes(args.kind) ? args.kind : 'expense', priority: text(args.priority, 30) || 'normal', emoji: text(args.emoji, 8) || '🏷️', limit: Math.max(0, money(args.limit || 0)), archived: false, createdAt: at, updatedAt: at, source: 'allofy', allofyCreated: true }); const ref = itemRef(uid, 'categories', id);
  return performAction({ uid, action: 'create_category', requestId: context.requestId, source: context.source, refs: [ref], compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_category', null, `Categoria “${name}” criada.`, { entity: { kind: 'category', id }, refresh: ['categories'] }) }) });
}

async function createBank(uid, args, context) {
  const name = text(args.name || args.institution, 100); if (!name) return resultError('name_required', 'Informe o nome ou instituição da conta.');
  const id = newId('bank_ai'); const at = nowIso(); const data = docDataWithOrder({ id, name, institution: text(args.institution, 100) || name, accountName: text(args.accountName, 100) || name, type: text(args.type, 40) || 'corrente', balance: money(args.balance || 0), balanceHistory: [], createdAt: at, updatedAt: at, lastReconciledAt: null, source: 'allofy', allofyCreated: true }); const ref = itemRef(uid, 'banks', id);
  return performAction({ uid, action: 'create_bank_account', requestId: context.requestId, source: context.source, refs: [ref], compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_bank_account', null, `Conta “${data.accountName}” cadastrada com saldo inicial de R$ ${data.balance.toFixed(2).replace('.', ',')}.`, { entity: { kind: 'bank', id }, refresh: ['banks'] }) }) });
}

async function reconcileBankBalance(uid, args, context) {
  const profile = await freshProfile(uid); const bankResult = resolveBank(profile, args.account, true); if (!bankResult.ok) return bankResult; const bank = bankResult.item;
  if (args.confirmed !== true) return resultError('confirmation_required', `Para alterar o saldo cadastrado de ${bankLabel(bank)} para R$ ${money(args.newBalance).toFixed(2).replace('.', ',')}, peça confirmação explícita ao usuário.`, { confirmation: { action: 'reconcile_bank_balance', account: bankLabel(bank), newBalance: money(args.newBalance) } });
  const ref = itemRef(uid, 'banks', bank.id); const at = nowIso(); const newBalance = money(args.newBalance);
  return performAction({ uid, action: 'reconcile_bank_balance', requestId: context.requestId, source: context.source, refs: [ref], compute: byPath => { const b = byPath.get(ref.path)?.data(); if (!b) return resultError('bank_not_found', 'A conta deixou de existir.'); const oldBalance = money(b.balance); const history = Array.isArray(b.balanceHistory) ? b.balanceHistory.slice(-99) : []; history.push({ id: newId('balance_ai'), oldBalance, newBalance, delta: money(newBalance - oldBalance), note: text(args.note, 160) || 'Conciliação feita pelo Allofy', date: todaySaoPaulo(), createdAt: at }); return { ok: true, writes: [{ type: 'set', ref, merge: true, data: { balance: newBalance, balanceHistory: history, updatedAt: at, lastReconciledAt: at } }], result: mutationResult('reconcile_bank_balance', null, `Saldo de ${bankLabel(b)} atualizado para R$ ${newBalance.toFixed(2).replace('.', ',')}.`, { entity: { kind: 'bank', id: bank.id }, refresh: ['banks'] }) }; } });
}

async function createCard(uid, args, context) {
  const name = text(args.name, 100); if (!name) return resultError('name_required', 'Informe o nome do cartão.'); const id = newId('card_ai'); const at = nowIso(); const data = docDataWithOrder({ id, name, brand: text(args.brand, 40), last4: text(args.last4, 4), limit: Math.max(0, money(args.limit || 0)), used: 0, currentInvoice: 0, closing: Math.max(1, Math.min(31, Number(args.closingDay || 1) | 0)), due: Math.max(1, Math.min(31, Number(args.dueDay || 1) | 0)), createdAt: at, updatedAt: at, source: 'allofy', allofyCreated: true }); const ref = itemRef(uid, 'cards', id);
  return performAction({ uid, action: 'create_card', requestId: context.requestId, source: context.source, refs: [ref], compute: () => ({ ok: true, writes: [{ type: 'set', ref, data }], result: mutationResult('create_card', null, `Cartão “${name}” cadastrado.`, { entity: { kind: 'card', id }, refresh: ['cards'] }) }) });
}

async function updateCardInvoice(uid, args, context) {
  const profile = await freshProfile(uid); const cardResult = resolveCard(profile, args.card, true); if (!cardResult.ok) return cardResult; const card = cardResult.item; const invoice = Math.max(0, money(args.invoice)); const ref = itemRef(uid, 'cards', card.id); const at = nowIso();
  return performAction({ uid, action: 'update_card_invoice', requestId: context.requestId, source: context.source, refs: [ref], compute: byPath => { if (!byPath.get(ref.path)?.exists) return resultError('card_not_found', 'O cartão deixou de existir.'); return { ok: true, writes: [{ type: 'set', ref, merge: true, data: { currentInvoice: invoice, used: args.used == null ? invoice : Math.max(0, money(args.used)), invoiceSource: 'manual', updatedAt: at } }], result: mutationResult('update_card_invoice', null, `Fatura de ${cardLabel(card)} atualizada para R$ ${invoice.toFixed(2).replace('.', ',')}.`, { entity: { kind: 'card', id: card.id }, refresh: ['cards'] }) }; } });
}

function findTransaction(profile, query) {
  const all = [...(profile.transactions || []), ...(profile.cardTransactions || [])];
  const byId = all.find(t => String(t.id) === String(query)); if (byId) return { item: byId, collection: (profile.cardTransactions || []).includes(byId) ? 'cardTransactions' : 'transactions' };
  const q = normalize(query); if (!q) return null; const matches = all.filter(t => normalize(t.description || t.desc || t.descricao).includes(q)); if (matches.length === 1) return { item: matches[0], collection: (profile.cardTransactions || []).includes(matches[0]) ? 'cardTransactions' : 'transactions' }; return { item: null, matches };
}

function explicitDeleteConfirmation(message) {
  const m = normalize(message);
  return /(confirmo|pode apagar|pode excluir|sim.*apaga|sim.*exclu|apaga mesmo|exclui mesmo|delete mesmo)/.test(m);
}

async function deleteTransaction(uid, args, context) {
  const profile = await freshProfile(uid); const found = findTransaction(profile, args.transaction); if (!found?.item) return found?.matches?.length > 1 ? resultError('transaction_ambiguous', 'Encontrei mais de um lançamento parecido. Diga qual deles ou use o identificador.', { choices: found.matches.slice(0, 8).map(t => ({ id: t.id, description: t.description || t.desc || t.descricao, amount: money(t.amount || t.valorTotal), date: t.date || t.dataCompra })) }) : resultError('transaction_not_found', 'Não encontrei esse lançamento.');
  const item = found.item; const label = item.description || item.desc || item.descricao || 'lançamento';
  if (args.confirmed !== true || !explicitDeleteConfirmation(context.userMessage || '')) return resultError('confirmation_required', `Confirme explicitamente antes de excluir “${text(label, 100)}”.`, { confirmation: { action: 'delete_transaction', transactionId: item.id, description: text(label, 100), amount: money(item.amount || item.valorTotal) } });
  if (found.collection === 'cardTransactions') {
    const ref = itemRef(uid, 'cardTransactions', item.id); return performAction({ uid, action: 'delete_transaction', requestId: context.requestId, source: context.source, refs: [ref], compute: byPath => byPath.get(ref.path)?.exists ? ({ ok: true, writes: [{ type: 'delete', ref }], result: mutationResult('delete_transaction', null, `Compra “${text(label, 100)}” excluída.`, { entity: { kind: 'card_purchase', id: item.id }, refresh: ['cardTransactions', 'cards'] }) }) : resultError('transaction_not_found', 'O lançamento já não existe.') });
  }
  const ref = itemRef(uid, 'transactions', item.id); const refs = [ref]; if (item.bankId && item.status === 'paid' && !item.coveredByBenefit) refs.push(itemRef(uid, 'banks', item.bankId));
  return performAction({ uid, action: 'delete_transaction', requestId: context.requestId, source: context.source, refs, compute: byPath => {
    const current = byPath.get(ref.path)?.data(); if (!current) return resultError('transaction_not_found', 'O lançamento já não existe.'); const writes = [{ type: 'delete', ref }];
    if (current.bankId && current.status === 'paid' && !current.coveredByBenefit) { const bankRef = itemRef(uid, 'banks', current.bankId); const b = byPath.get(bankRef.path)?.data(); if (b) { const delta = current.type === 'income' ? -money(current.amount) : money(current.amount); writes.push({ type: 'set', ref: bankRef, merge: true, data: { balance: money(money(b.balance) + delta), updatedAt: nowIso() } }); } }
    return { ok: true, writes, result: mutationResult('delete_transaction', null, `Lançamento “${text(label, 100)}” excluído.`, { entity: { kind: 'transaction', id: item.id }, refresh: ['transactions', ...(current.bankId ? ['banks'] : [])] }) };
  } });
}

async function undoAction(uid, args, context) {
  const requested = text(args.actionId, 120);
  let logRef;
  if (requested) logRef = actionLogRef(uid, requested);
  else {
    const snap = await userRef(uid).collection(ACTION_LOG_COLLECTION).where('undoneAt', '==', null).orderBy('createdAtIso', 'desc').limit(1).get().catch(() => null);
    if (snap?.empty === false) logRef = snap.docs[0].ref;
    if (!logRef) {
      const fallback = await userRef(uid).collection(ACTION_LOG_COLLECTION).orderBy('createdAtIso', 'desc').limit(10).get();
      const candidate = fallback.docs.find(d => !d.data()?.undoneAt && d.data()?.action !== 'undo_action');
      if (candidate) logRef = candidate.ref;
    }
  }
  if (!logRef) return resultError('nothing_to_undo', 'Não encontrei uma ação recente do Allofy para desfazer.');
  const initial = await logRef.get(); if (!initial.exists) return resultError('action_not_found', 'Não encontrei essa ação.'); const initialData = initial.data() || {}; const operations = Array.isArray(initialData.operations) ? initialData.operations : [];
  if (!operations.length) return resultError('not_undoable', 'Essa ação não possui dados suficientes para desfazer.');
  const refs = operations.map(op => getDb().doc(op.path)); const at = nowIso();
  return getDb().runTransaction(async tx => {
    const [freshLog, ...currentSnaps] = await Promise.all([tx.get(logRef), ...refs.map(ref => tx.get(ref))]); const log = freshLog.data() || {}; if (log.undoneAt) return resultError('already_undone', 'Essa ação já foi desfeita.');
    operations.forEach((op, index) => { const ref = refs[index]; if (!op.before) tx.delete(ref); else tx.set(ref, op.before, { merge: false }); });
    tx.set(logRef, { undoneAt: admin.firestore.FieldValue.serverTimestamp(), undoneAtIso: at, undoneFrom: normalizeSource(context.source) }, { merge: true });
    return { ok: true, mutated: true, action: 'undo_action', actionId: logRef.id, undoable: false, summary: `Ação anterior desfeita: ${log.result?.summary || log.action || 'alteração do Allofy'}.`, refresh: ['transactions', 'banks', 'cards', 'cardTransactions', 'goals', 'debts', 'categories'] };
  });
}

const nullableString = { type: ['string', 'null'] };
const actionTools = [
  { type: 'function', name: 'create_transaction', description: 'Cria uma receita ou despesa no Allofy. Se status=paid e houver conta, atualiza o saldo cadastrado da conta. Use para comandos como “gastei 35 no almoço” ou “recebi 2.000 de salário”. Não use para compra no cartão.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { description: { type: 'string', minLength: 1, maxLength: 160 }, amount: { type: 'number', exclusiveMinimum: 0 }, type: { type: 'string', enum: ['expense', 'income'] }, date: nullableString, category: nullableString, account: nullableString, status: { type: 'string', enum: ['paid', 'pending'] }, recurrence: { type: 'string', enum: ['fixed', 'variable', 'installment'] }, notes: nullableString }, required: ['description', 'amount', 'type', 'date', 'category', 'account', 'status', 'recurrence', 'notes'] } },
  { type: 'function', name: 'create_card_purchase', description: 'Registra uma compra no cartão de crédito no Allofy, inclusive parcelamento. Não movimenta saldo bancário.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { description: { type: 'string', minLength: 1, maxLength: 160 }, amount: { type: 'number', exclusiveMinimum: 0 }, card: { type: 'string', minLength: 1, maxLength: 120 }, installments: { type: 'integer', minimum: 1, maximum: 60 }, installmentAmount: { type: ['number', 'null'], minimum: 0 }, date: nullableString, category: nullableString, notes: nullableString }, required: ['description', 'amount', 'card', 'installments', 'installmentAmount', 'date', 'category', 'notes'] } },
  { type: 'function', name: 'record_transfer', description: 'REGISTRA no Allofy uma transferência entre duas contas cadastradas e ajusta os saldos do app. Não envia dinheiro nem acessa banco real.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { fromAccount: { type: 'string' }, toAccount: { type: 'string' }, amount: { type: 'number', exclusiveMinimum: 0 }, date: nullableString, description: nullableString }, required: ['fromAccount', 'toAccount', 'amount', 'date', 'description'] } },
  { type: 'function', name: 'create_goal', description: 'Cria uma meta financeira no Allofy.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, target: { type: 'number', exclusiveMinimum: 0 }, current: { type: 'number', minimum: 0 }, monthlyContribution: { type: 'number', minimum: 0 }, deadline: nullableString, description: nullableString, icon: nullableString, color: nullableString }, required: ['name', 'target', 'current', 'monthlyContribution', 'deadline', 'description', 'icon', 'color'] } },
  { type: 'function', name: 'add_goal_progress', description: 'Adiciona progresso a uma meta já cadastrada. Altera somente o acompanhamento da meta; não debita conta bancária automaticamente.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { goal: { type: 'string' }, amount: { type: 'number', exclusiveMinimum: 0 }, note: nullableString }, required: ['goal', 'amount', 'note'] } },
  { type: 'function', name: 'create_debt', description: 'Cadastra uma dívida ou financiamento no Allofy.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, total: { type: 'number', exclusiveMinimum: 0 }, paid: { type: 'number', minimum: 0 }, installment: { type: 'number', minimum: 0 }, installmentsTotal: { type: 'integer', minimum: 0 }, startDate: nullableString, dueDay: { type: 'integer', minimum: 1, maximum: 31 }, icon: nullableString }, required: ['name', 'total', 'paid', 'installment', 'installmentsTotal', 'startDate', 'dueDay', 'icon'] } },
  { type: 'function', name: 'record_debt_payment', description: 'Registra pagamento de dívida. Se uma conta for informada, reduz o saldo cadastrado e cria a despesa correspondente.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { debt: { type: 'string' }, amount: { type: 'number', exclusiveMinimum: 0 }, account: nullableString, date: nullableString }, required: ['debt', 'amount', 'account', 'date'] } },
  { type: 'function', name: 'create_category', description: 'Cria uma nova categoria de receita/despesa e pode definir orçamento/limite mensal.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, description: nullableString, kind: { type: 'string', enum: ['expense', 'income', 'both'] }, priority: nullableString, emoji: nullableString, limit: { type: 'number', minimum: 0 } }, required: ['name', 'description', 'kind', 'priority', 'emoji', 'limit'] } },
  { type: 'function', name: 'create_bank_account', description: 'Cadastra uma conta financeira dentro do Allofy. Não abre conta em instituição real.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { name: nullableString, institution: nullableString, accountName: nullableString, type: nullableString, balance: { type: 'number' } }, required: ['name', 'institution', 'accountName', 'type', 'balance'] } },
  { type: 'function', name: 'reconcile_bank_balance', description: 'Altera o saldo cadastrado de uma conta no Allofy. É uma alteração de alto impacto e exige confirmação explícita.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { account: { type: 'string' }, newBalance: { type: 'number' }, note: nullableString, confirmed: { type: 'boolean' } }, required: ['account', 'newBalance', 'note', 'confirmed'] } },
  { type: 'function', name: 'create_card', description: 'Cadastra um cartão no Allofy. Não solicita nem cria cartão real.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, brand: nullableString, last4: nullableString, limit: { type: 'number', minimum: 0 }, closingDay: { type: 'integer', minimum: 1, maximum: 31 }, dueDay: { type: 'integer', minimum: 1, maximum: 31 } }, required: ['name', 'brand', 'last4', 'limit', 'closingDay', 'dueDay'] } },
  { type: 'function', name: 'update_card_invoice', description: 'Atualiza manualmente o valor da fatura e limite usado de um cartão cadastrado.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { card: { type: 'string' }, invoice: { type: 'number', minimum: 0 }, used: { type: ['number', 'null'], minimum: 0 } }, required: ['card', 'invoice', 'used'] } },
  { type: 'function', name: 'delete_transaction', description: 'Exclui uma transação ou compra. SEMPRE exige confirmação explícita do usuário em uma mensagem separada; nunca use apenas por inferência.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { transaction: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['transaction', 'confirmed'] } },
  { type: 'function', name: 'undo_allofy_action', description: 'Desfaz a ação mutável mais recente feita pelo Allofy, ou uma ação específica pelo actionId. Use quando o usuário disser “desfaz”, “volta” ou “foi errado”.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { actionId: nullableString }, required: ['actionId'] } },
];

const ACTION_NAMES = new Set(actionTools.map(tool => tool.name));
function isActionTool(name) { return ACTION_NAMES.has(name); }

async function executeAllofyAction(name, args, uid, context = {}) {
  if (name === 'create_transaction') return createTransaction(uid, args, context);
  if (name === 'create_card_purchase') return createCardPurchase(uid, args, context);
  if (name === 'record_transfer') return recordTransfer(uid, args, context);
  if (name === 'create_goal') return createGoal(uid, args, context);
  if (name === 'add_goal_progress') return addGoalProgress(uid, args, context);
  if (name === 'create_debt') return createDebt(uid, args, context);
  if (name === 'record_debt_payment') return recordDebtPayment(uid, args, context);
  if (name === 'create_category') return createCategory(uid, args, context);
  if (name === 'create_bank_account') return createBank(uid, args, context);
  if (name === 'reconcile_bank_balance') return reconcileBankBalance(uid, args, context);
  if (name === 'create_card') return createCard(uid, args, context);
  if (name === 'update_card_invoice') return updateCardInvoice(uid, args, context);
  if (name === 'delete_transaction') return deleteTransaction(uid, args, context);
  if (name === 'undo_allofy_action') return undoAction(uid, args, context);
  throw new Error(`Ação desconhecida: ${name}`);
}

module.exports = { actionTools, isActionTool, executeAllofyAction, normalizeSource };
