const crypto = require('crypto');
const { getDb, admin } = require('../config/firebase');
const { createStructuredResponse } = require('../config/openai');
const { policyForProfile } = require('./allofyUsageService');

const IMAGE_CONTEXT_COLLECTION = 'allofy_image_contexts';
const IMAGE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_ITEMS = 50;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const IMAGE_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentType: { type: 'string', maxLength: 80 },
    summary: { type: 'string', maxLength: 2400 },
    cardHint: { type: ['string', 'null'], maxLength: 120 },
    accountHint: { type: ['string', 'null'], maxLength: 120 },
    currency: { type: ['string', 'null'], maxLength: 12 },
    detectedTotal: { type: ['number', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsUserReview: { type: 'boolean' },
    textHighlights: {
      type: 'array', maxItems: 12,
      items: { type: 'string', maxLength: 240 },
    },
    warnings: {
      type: 'array', maxItems: 12,
      items: { type: 'string', maxLength: 280 },
    },
    items: {
      type: 'array', maxItems: MAX_CONTEXT_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['card_purchase', 'expense', 'income', 'unknown'] },
          description: { type: 'string', maxLength: 160 },
          amount: { type: ['number', 'null'] },
          date: { type: ['string', 'null'], maxLength: 10 },
          installments: { type: ['integer', 'null'], minimum: 1, maximum: 60 },
          installmentAmount: { type: ['number', 'null'] },
          category: { type: ['string', 'null'], maxLength: 100 },
          status: { type: ['string', 'null'], enum: ['paid', 'pending', null] },
          notes: { type: ['string', 'null'], maxLength: 300 },
        },
        required: ['kind', 'description', 'amount', 'date', 'installments', 'installmentAmount', 'category', 'status', 'notes'],
      },
    },
  },
  required: ['documentType', 'summary', 'cardHint', 'accountHint', 'currency', 'detectedTotal', 'confidence', 'needsUserReview', 'textHighlights', 'warnings', 'items'],
};

function contextRef(uid) {
  return getDb().collection(IMAGE_CONTEXT_COLLECTION).doc(String(uid));
}

function sanitizeText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeItem(item = {}, index = 0) {
  return {
    index,
    kind: ['card_purchase', 'expense', 'income', 'unknown'].includes(item.kind) ? item.kind : 'unknown',
    description: sanitizeText(item.description, 160),
    amount: safeNumber(item.amount),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) ? String(item.date) : null,
    installments: Number.isInteger(item.installments) && item.installments > 0 ? Math.min(60, item.installments) : null,
    installmentAmount: safeNumber(item.installmentAmount),
    category: item.category == null ? null : sanitizeText(item.category, 100),
    status: ['paid', 'pending'].includes(item.status) ? item.status : null,
    notes: item.notes == null ? null : sanitizeText(item.notes, 300),
  };
}

function normalizeAnalysis(raw = {}, meta = {}) {
  const items = Array.isArray(raw.items) ? raw.items.slice(0, MAX_CONTEXT_ITEMS).map(normalizeItem) : [];
  return {
    imageHash: meta.imageHash,
    filename: sanitizeText(meta.filename, 120),
    mimeType: meta.mimeType,
    documentType: sanitizeText(raw.documentType || 'imagem', 80) || 'imagem',
    summary: sanitizeText(raw.summary, 2400),
    cardHint: raw.cardHint == null ? null : sanitizeText(raw.cardHint, 120),
    accountHint: raw.accountHint == null ? null : sanitizeText(raw.accountHint, 120),
    currency: raw.currency == null ? null : sanitizeText(raw.currency, 12),
    detectedTotal: safeNumber(raw.detectedTotal),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    needsUserReview: raw.needsUserReview === true,
    textHighlights: Array.isArray(raw.textHighlights) ? raw.textHighlights.slice(0, 12).map(value => sanitizeText(value, 240)).filter(Boolean) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 12).map(value => sanitizeText(value, 280)).filter(Boolean) : [],
    items,
    financialItemCount: items.filter(item => item.amount != null && item.amount > 0 && item.kind !== 'unknown').length,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + IMAGE_CONTEXT_TTL_MS,
  };
}

function imageHash(file) {
  return crypto.createHash('sha256').update(file.buffer).digest('hex');
}

function detectedImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function validateImageFile(file) {
  if (!file?.buffer?.length) {
    const error = new Error('Selecione uma imagem para enviar ao Allofy.');
    error.status = 400;
    error.code = 'image_required';
    throw error;
  }
  const declaredType = String(file.mimetype || '').toLowerCase();
  const actualType = detectedImageType(file.buffer);
  if (!SUPPORTED_IMAGE_TYPES.has(declaredType) || !actualType || actualType !== declaredType) {
    const error = new Error('Use uma imagem PNG, JPG/JPEG ou WEBP válida.');
    error.status = 400;
    error.code = 'unsupported_image_type';
    throw error;
  }
}

async function analyzeAllofyImage(uid, profile = {}, file, userMessage = '') {
  validateImageFile(file);
  const policy = policyForProfile(profile);
  const hash = imageHash(file);
  const prompt = `Analise a imagem enviada pelo usuário do Allo Finanças.

Objetivos:
- Entender qualquer imagem de forma geral e resumir o conteúdo útil.
- Se for fatura, extrato, comprovante, cobrança ou tela financeira, extraia SOMENTE os lançamentos realmente visíveis.
- Nunca invente loja, data, valor, cartão, conta, parcela ou categoria que não esteja legível.
- Valores devem ser números positivos sem símbolo de moeda. Datas completas devem ser AAAA-MM-DD; se não houver data completa, use null.
- Se for compra de cartão/fatura, use kind=card_purchase. Despesa fora do cartão: expense. Receita: income. Se não for lançamento financeiro: unknown.
- Não copie número completo de cartão, CVV, senha, token, CPF completo ou outros segredos. Se aparecerem, omita-os do resumo.
- Em faturas com vários itens, extraia cada compra separadamente na ordem visual em que aparece.
- Em uma FATURA, se uma linha mostrar algo como parcela 2/10 e apenas o valor cobrado nesta fatura, NÃO trate esse valor como total de uma compra parcelada: use installments=1, installmentAmount=null e registre a informação 'parcela 2/10' em notes. Só use installments>1 quando a imagem mostrar claramente o valor total original da compra e a quantidade de parcelas.
- Marque needsUserReview=true se algum valor/data importante estiver pouco legível, cortado ou ambíguo.

Pedido do usuário: ${sanitizeText(userMessage || 'Analise esta imagem.', 1200)}`;

  const raw = await createStructuredResponse({
    model: policy.visionModel || policy.agentModel,
    reasoning: { effort: policy.tier === 'free' ? 'low' : 'medium' },
    instructions: 'Você é o módulo de visão do Allofy. Extraia fatos visuais com precisão e sem inventar. Retorne apenas o JSON do schema.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, detail: 'high' },
      ],
    }],
    name: 'allofy_image_analysis',
    schema: IMAGE_ANALYSIS_SCHEMA,
    maxOutputTokens: policy.tier === 'free' ? 2200 : 5000,
  });

  const context = normalizeAnalysis(raw, {
    imageHash: hash,
    filename: file.originalname || 'imagem',
    mimeType: file.mimetype,
  });

  await contextRef(uid).set({
    ...context,
    uid: String(uid),
    sourceMessage: sanitizeText(userMessage, 1500),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false });

  return context;
}

async function loadRecentImageContext(uid) {
  const snap = await contextRef(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const expiresAtMs = Number(data.expiresAtMs || 0);
  if (!expiresAtMs || expiresAtMs < Date.now()) {
    await contextRef(uid).delete().catch(() => {});
    return null;
  }
  return { ...data, uid: undefined };
}

async function clearImageContext(uid) {
  await contextRef(uid).delete().catch(() => {});
}

function compactImageContext(context) {
  if (!context) return '';
  return JSON.stringify({
    documentType: context.documentType,
    summary: context.summary,
    cardHint: context.cardHint,
    accountHint: context.accountHint,
    currency: context.currency,
    detectedTotal: context.detectedTotal,
    confidence: context.confidence,
    needsUserReview: context.needsUserReview,
    warnings: context.warnings,
    items: context.items,
  });
}

function imageImportFingerprint(context, index) {
  if (!context?.imageHash || !Number.isInteger(index) || index < 0) return null;
  return crypto.createHash('sha256').update(`${context.imageHash}:${index}`).digest('hex');
}

function matchImageItem(context, args = {}, usedIndexes = new Set(), actionName = '') {
  if (!context?.items?.length) return null;
  const wantedKind = actionName === 'create_card_purchase' ? 'card_purchase' : null;
  const amount = Number(args.amount);
  const description = sanitizeText(args.description, 160).toLocaleLowerCase('pt-BR');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : null;
  let best = null;
  for (const item of context.items) {
    if (usedIndexes.has(item.index)) continue;
    if (wantedKind && item.kind !== wantedKind) continue;
    if (actionName === 'create_transaction' && item.kind === 'card_purchase') continue;
    let score = 0;
    if (Number.isFinite(amount) && item.amount != null && Math.abs(Number(item.amount) - amount) < 0.01) score += 6;
    if (date && item.date && date === item.date) score += 3;
    const itemDescription = sanitizeText(item.description, 160).toLocaleLowerCase('pt-BR');
    if (description && itemDescription && (description.includes(itemDescription) || itemDescription.includes(description))) score += 4;
    if (!best || score > best.score) best = { item, score };
  }
  if (!best || best.score < 4) return null;
  usedIndexes.add(best.item.index);
  return {
    index: best.item.index,
    fingerprint: imageImportFingerprint(context, best.item.index),
  };
}

module.exports = {
  IMAGE_CONTEXT_COLLECTION,
  IMAGE_ANALYSIS_SCHEMA,
  SUPPORTED_IMAGE_TYPES,
  analyzeAllofyImage,
  loadRecentImageContext,
  clearImageContext,
  compactImageContext,
  imageImportFingerprint,
  matchImageItem,
  normalizeAnalysis,
  detectedImageType,
};
