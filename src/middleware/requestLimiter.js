const buckets = new Map();

function requestLimiter({ windowMs = 60_000, max = 20, key = req => req.userIdentity?.uid || req.ip || 'anonymous' } = {}) {
  return function limitRequest(req, res, next) {
    const now = Date.now();
    const id = String(key(req));
    const current = buckets.get(id);
    if (!current || current.resetAt <= now) {
      buckets.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (current.count >= max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    }
    current.count += 1;
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, value] of buckets.entries()) if (value.resetAt <= now) buckets.delete(id);
}, 5 * 60_000).unref?.();

module.exports = { requestLimiter };
