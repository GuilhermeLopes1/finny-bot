'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function toMillis(value) {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function toIsoOrNull(value) {
  const ms = toMillis(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function maxExpiry(values) {
  let max = 0;
  for (const value of values) max = Math.max(max, toMillis(value));
  return max > 0 ? new Date(max).toISOString() : null;
}

function dedicatedExpiryValues(profile = {}) {
  return [
    profile.googlePlayExpiresAt,
    profile.proManualExpiresAt,
    profile.proPrizeExpiresAt,
    profile.proReferralExpiresAt,
    profile.legacyProExpiresAt,
  ];
}

/**
 * Preserva uma validade Pro já existente antes de sincronizar a Google Play.
 * Isso evita que um prêmio, liberação administrativa ou plano legado seja
 * encurtado por uma assinatura da loja com vencimento menor.
 */
function captureLegacyExpiry(profile = {}, patch = {}, now = new Date()) {
  const nowMs = now.getTime();
  const currentMs = toMillis(profile.proExpiresAt);
  const knownMs = toMillis(maxExpiry([...dedicatedExpiryValues(profile), ...dedicatedExpiryValues(patch)]));

  if (profile.isPro === true && currentMs > nowMs && currentMs > knownMs + 1000) {
    return new Date(Math.max(currentMs, toMillis(profile.legacyProExpiresAt))).toISOString();
  }

  return profile.legacyProExpiresAt || patch.legacyProExpiresAt || null;
}

function buildEffectiveProUpdate(profile = {}, sourcePatch = {}, now = new Date()) {
  const merged = { ...profile, ...sourcePatch };
  const legacyProExpiresAt = captureLegacyExpiry(profile, sourcePatch, now);
  if (legacyProExpiresAt) merged.legacyProExpiresAt = legacyProExpiresAt;

  const effectiveExpiry = maxExpiry(dedicatedExpiryValues(merged));
  const expiryMs = toMillis(effectiveExpiry);
  const active = expiryMs > now.getTime();

  const update = {
    ...sourcePatch,
    legacyProExpiresAt: legacyProExpiresAt || null,
    isPro: active,
    proExpiresAt: effectiveExpiry,
    proDaysLeft: active ? Math.max(1, Math.ceil((expiryMs - now.getTime()) / DAY_MS)) : 0,
    proExpired: !active,
    updatedAt: now.toISOString(),
  };

  if (active) {
    update.proExpiredAt = null;
    update.proSince = profile.proSince || sourcePatch.proSince || now.toISOString();
  } else {
    update.proExpiredAt = profile.proExpiredAt || now.toISOString();
  }

  return update;
}

module.exports = {
  DAY_MS,
  toMillis,
  toIsoOrNull,
  maxExpiry,
  captureLegacyExpiry,
  buildEffectiveProUpdate,
};
