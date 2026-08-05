const crypto = require('crypto');

function parseSignature(value) {
  return String(value || '').split(',').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const itemValue = part.slice(index + 1).trim();
    if (key) acc[key] = itemValue;
    return acc;
  }, {});
}

function safeEqualHex(expected, received) {
  if (!/^[a-f0-9]{64}$/i.test(String(expected || '')) || !/^[a-f0-9]{64}$/i.test(String(received || ''))) return false;
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(received, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyMercadoPagoSignature({ signature, requestId, dataId, secret, now = Date.now(), maxAgeMs = 10 * 60 * 1000 }) {
  if (!signature || !requestId || dataId === undefined || dataId === null || !secret) return false;
  const parsed = parseSignature(signature);
  const ts = String(parsed.ts || '').trim();
  const received = String(parsed.v1 || '').trim();
  if (!/^\d{10,16}$/.test(ts) || !received) return false;

  const timestamp = Number(ts);
  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) return false;

  const normalizedDataId = String(dataId).toLowerCase();
  const manifest = `id:${normalizedDataId};request-id:${requestId};ts:${ts};`;
  const generated = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return safeEqualHex(generated, received);
}

function webhookEventId(type, dataId, action = '') {
  return crypto.createHash('sha256')
    .update(`${String(type || '')}|${String(dataId || '')}|${String(action || '')}`)
    .digest('hex');
}

module.exports = { parseSignature, verifyMercadoPagoSignature, webhookEventId };
