const { getDb, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const minuteBuckets = new Map();

function dailyLimitFor(kind) {
  if (kind === 'allofy') return Number(process.env.ALLOFY_DAILY_LIMIT || 250);
  if (kind === 'allofy_voice') return Number(process.env.ALLOFY_VOICE_DAILY_LIMIT || 150);
  if (kind === 'allofy_realtime') return Number(process.env.ALLOFY_REALTIME_DAILY_LIMIT || 100);
  if (kind === 'allofy_tool') return Number(process.env.ALLOFY_TOOL_DAILY_LIMIT || 500);
  return Number(process.env.AI_DAILY_LIMIT || 120);
}

function aiRateLimiter(kind = 'allofy') {
  return async function limitAiRequest(req, res, next) {
    const uid = req.userIdentity?.uid;
    if (!uid) return res.status(401).json({ error: 'Autenticação necessária.' });

    const now = Date.now();
    const minuteLimit = Number(process.env.AI_MINUTE_LIMIT || 30);
    const dailyLimit = dailyLimitFor(kind);
    const minuteKey = `${uid}:${kind}`;
    const bucket = minuteBuckets.get(minuteKey);

    if (!bucket || now >= bucket.resetAt) minuteBuckets.set(minuteKey, { count: 1, resetAt: now + 60000 });
    else if (bucket.count >= minuteLimit) return res.status(429).json({ error: 'Muitas solicitações seguidas. Aguarde um minuto.', code: 'minute_limit' });
    else bucket.count += 1;

    try {
      const day = new Date().toISOString().slice(0, 10);
      const ref = getDb().collection('ai_usage').doc(`${uid}_${day}_${kind}`);
      const result = await getDb().runTransaction(async tx => {
        const snap = await tx.get(ref);
        const count = Number(snap.data()?.count || 0);
        if (count >= dailyLimit) return { allowed: false, count };
        tx.set(ref, { uid, kind, day, count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { allowed: true, count: count + 1 };
      });
      const remaining = Math.max(0, dailyLimit - result.count);
      res.setHeader('X-AI-Limit', String(dailyLimit));
      res.setHeader('X-AI-Remaining', String(remaining));
      req.aiUsage = { remaining, limit: dailyLimit };
      if (!result.allowed) return res.status(429).json({ error: 'Você atingiu o limite diário do Allofy.', code: 'daily_limit', remaining: 0 });
      next();
    } catch (error) {
      logger.error(`Falha ao conferir limite de IA: ${error.message}`);
      res.status(503).json({ error: 'Não foi possível validar o uso da IA agora.' });
    }
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of minuteBuckets) if (now >= value.resetAt) minuteBuckets.delete(key);
}, 5 * 60000).unref();

module.exports = { aiRateLimiter, dailyLimitFor };
