/**
 * Rate Limiter Middleware
 * Prevents abuse — limits each phone number to N messages per minute
 */

const logger = require('../utils/logger');

const requestMap = new Map(); // userId -> { count, resetAt }

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 20; // per window per user

/**
 * Extract userId from request body (works for both Twilio and Z-API)
 */
function extractUserId(body) {
  const from = body?.From || body?.phone || body?.from || '';
  return from.replace(/\D/g, '').slice(-11); // last 11 digits
}

function rateLimiter(req, res, next) {
  const userId = extractUserId(req.body);
  if (!userId) return next();

  const now = Date.now();
  const entry = requestMap.get(userId);

  if (!entry || now > entry.resetAt) {
    requestMap.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (entry.count >= MAX_REQUESTS) {
    logger.warn(`Rate limit hit for user ${userId}`);
    return res.status(429).send('Too Many Requests');
  }

  entry.count += 1;
  return next();
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of requestMap.entries()) {
    if (now > val.resetAt) requestMap.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { rateLimiter };
