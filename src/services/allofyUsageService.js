const { getDb, admin } = require('../config/firebase');
const { monthKey } = require('../utils/saoPaulo');
const logger = require('../utils/logger');

const TIER = Object.freeze({ FREE: 'free', PRO: 'pro', ADMIN: 'admin' });

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function policyForProfile(profile = {}) {
  const isAdmin = profile.role === 'admin' || profile.isAdmin === true;
  const isPro = profile.isPro === true || isAdmin;
  if (isAdmin) {
    return {
      tier: TIER.ADMIN,
      label: 'Admin',
      commandLimit: null,
      voiceCommandLimit: null,
      imageLimit: null,
      liveSecondsLimit: null,
      liveSessionMaxSeconds: positiveInt(process.env.ALLOFY_LIVE_SESSION_MAX_MINUTES, 10) * 60,
      agentModel: process.env.OPENAI_AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6',
      visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-5.6',
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'max',
      transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      liveModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini',
      features: { basicAi: true, quickVoice: true, imageVision: true, advancedActions: true, live: true, widgetLive: true },
    };
  }
  if (isPro) {
    return {
      tier: TIER.PRO,
      label: 'Pro',
      commandLimit: positiveInt(process.env.ALLOFY_PRO_COMMANDS_MONTHLY, 150),
      voiceCommandLimit: positiveInt(process.env.ALLOFY_PRO_VOICE_COMMANDS_MONTHLY, 150),
      imageLimit: positiveInt(process.env.ALLOFY_PRO_IMAGES_MONTHLY, 40),
      liveSecondsLimit: positiveInt(process.env.ALLOFY_PRO_LIVE_MINUTES_MONTHLY, 25) * 60,
      liveSessionMaxSeconds: positiveInt(process.env.ALLOFY_LIVE_SESSION_MAX_MINUTES, 10) * 60,
      agentModel: process.env.OPENAI_AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.6',
      visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-5.6',
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'max',
      transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      liveModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini',
      features: { basicAi: true, quickVoice: true, imageVision: true, advancedActions: true, live: true, widgetLive: true },
    };
  }
  return {
    tier: TIER.FREE,
    label: 'Grátis',
    commandLimit: positiveInt(process.env.ALLOFY_FREE_COMMANDS_MONTHLY, 20),
    voiceCommandLimit: positiveInt(process.env.ALLOFY_FREE_VOICE_COMMANDS_MONTHLY, 5),
    imageLimit: positiveInt(process.env.ALLOFY_FREE_IMAGES_MONTHLY, 2),
    liveSecondsLimit: 0,
    liveSessionMaxSeconds: 0,
    agentModel: process.env.OPENAI_FREE_AGENT_MODEL || 'gpt-5.6-luna',
    visionModel: process.env.OPENAI_FREE_VISION_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-5.6',
    reasoningEffort: process.env.OPENAI_FREE_REASONING_EFFORT || 'low',
    transcribeModel: process.env.OPENAI_FREE_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    liveModel: null,
    features: { basicAi: true, quickVoice: true, imageVision: true, advancedActions: false, live: false, widgetLive: false },
  };
}

function resetAtIso(month = monthKey()) {
  const [year, mon] = String(month).split('-').map(Number);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;
  // São Paulo usa UTC-3 atualmente. 00:00 local = 03:00 UTC.
  return new Date(Date.UTC(nextYear, nextMonth - 1, 1, 3, 0, 0)).toISOString();
}

function usageDocumentId(uid, month = monthKey()) {
  return `${uid}_${month}`;
}

function usageRef(uid, month = monthKey()) {
  return getDb().collection('allofy_usage').doc(usageDocumentId(uid, month));
}

function toCounter(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function remaining(limit, used) {
  return limit === null ? null : Math.max(0, Number(limit || 0) - toCounter(used));
}

function snapshotFromData(policy, data = {}, month = monthKey()) {
  const commands = toCounter(data.commands);
  const voiceCommands = toCounter(data.voiceCommands);
  const images = toCounter(data.images);
  const liveSeconds = toCounter(data.liveChargedSeconds);
  return {
    month,
    tier: policy.tier,
    planLabel: policy.label,
    resetAt: resetAtIso(month),
    commands: { used: commands, limit: policy.commandLimit, remaining: remaining(policy.commandLimit, commands) },
    quickVoice: { used: voiceCommands, limit: policy.voiceCommandLimit, remaining: remaining(policy.voiceCommandLimit, voiceCommands) },
    images: { used: images, limit: policy.imageLimit, remaining: remaining(policy.imageLimit, images) },
    live: {
      usedSeconds: liveSeconds,
      usedMinutes: Number((liveSeconds / 60).toFixed(1)),
      limitSeconds: policy.liveSecondsLimit,
      limitMinutes: policy.liveSecondsLimit === null ? null : Number((policy.liveSecondsLimit / 60).toFixed(0)),
      remainingSeconds: remaining(policy.liveSecondsLimit, liveSeconds),
      remainingMinutes: policy.liveSecondsLimit === null ? null : Number((remaining(policy.liveSecondsLimit, liveSeconds) / 60).toFixed(1)),
      sessionMaxSeconds: policy.liveSessionMaxSeconds,
    },
    features: policy.features,
    models: {
      agent: policy.agentModel,
      vision: policy.visionModel,
      quickVoice: policy.transcribeModel,
      live: policy.liveModel,
    },
  };
}

async function getUsageSnapshot(uid, profile = {}) {
  const policy = policyForProfile(profile);
  if (policy.tier === TIER.ADMIN) return snapshotFromData(policy, {}, monthKey());
  const month = monthKey();
  const snap = await usageRef(uid, month).get();
  return snapshotFromData(policy, snap.data() || {}, month);
}

function quotaError(code, message, snapshot) {
  const error = new Error(message);
  error.status = 429;
  error.code = code;
  error.usage = snapshot;
  return error;
}

async function maybeSendUsageNotification(uid, profile, kind, snapshot) {
  try {
    const prefs = profile.notificationPreferences || {};
    if (prefs.enabled !== true || prefs.aiUsageAlerts === false || profile.pushEnabled === false) return;
    const month = snapshot.month;
    const ref = usageRef(uid, month);
    const doc = (await ref.get()).data() || {};
    const flags = doc.notificationFlags || {};

    let key = '';
    let notification = null;
    if (kind === 'commands' && snapshot.commands.limit) {
      const ratio = snapshot.commands.used / snapshot.commands.limit;
      if (ratio >= 1) {
        key = 'commands100';
        notification = {
          title: '🌙 Seu Allofy já trabalhou bastante este mês',
          body: snapshot.tier === TIER.FREE
            ? 'Seu limite gratuito de IA foi usado. O app continua normal — o Allofy volta no próximo ciclo ou você pode conhecer o Pro.'
            : 'Sua franquia mensal de comandos de IA foi usada. Seus outros recursos continuam disponíveis normalmente.',
          tag: `allofy-usage-commands-${month}`,
          url: '/app?action=open-allofy&via=notification',
        };
      } else if (ratio >= 0.8) {
        key = 'commands80';
        notification = {
          title: '✨ Seu Allofy está a todo vapor',
          body: `Você já usou ${snapshot.commands.used} de ${snapshot.commands.limit} comandos neste ciclo. Ainda restam ${snapshot.commands.remaining}.`,
          tag: `allofy-usage-commands-80-${month}`,
          url: '/app?action=open-allofy&via=notification',
        };
      }
    }
    if (kind === 'live' && snapshot.live.limitSeconds) {
      const ratio = snapshot.live.usedSeconds / snapshot.live.limitSeconds;
      if (ratio >= 1) {
        key = 'live100';
        notification = {
          title: '🎙️ Allofy Live: franquia concluída',
          body: 'Os minutos de conversa ao vivo deste ciclo foram usados. O chat e os demais recursos do Pro continuam funcionando.',
          tag: `allofy-live-100-${month}`,
          url: '/app?action=open-allofy&via=notification',
        };
      } else if (ratio >= 0.8) {
        key = 'live80';
        notification = {
          title: '🎙️ Seu Allofy Live está quase no limite',
          body: `Restam cerca de ${snapshot.live.remainingMinutes} min de conversa ao vivo neste ciclo.`,
          tag: `allofy-live-80-${month}`,
          url: '/app?action=open-allofy&via=notification',
        };
      }
    }
    if (!key || !notification || flags[key]) return;

    const { sendPushToProfile } = require('./notificationService');
    const sent = await sendPushToProfile(uid, profile, notification);
    if (sent) {
      await ref.set({ notificationFlags: { ...flags, [key]: new Date().toISOString() } }, { merge: true });
    }
  } catch (error) {
    logger.warn(`Allofy usage notification: ${error.message}`);
  }
}

async function consumeChatRequest(uid, profile = {}, options = {}) {
  const policy = policyForProfile(profile);
  const withImage = options.withImage === true;
  if (policy.commandLimit === null && (!withImage || policy.imageLimit === null)) return getUsageSnapshot(uid, profile);
  const month = monthKey();
  const ref = usageRef(uid, month);
  let result;
  await getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data() || {};
    const usedCommands = toCounter(data.commands);
    const usedImages = toCounter(data.images);
    if (policy.commandLimit !== null && usedCommands >= policy.commandLimit) {
      result = { allowed: false, code: 'monthly_command_limit', data };
      return;
    }
    if (withImage && policy.imageLimit !== null && usedImages >= policy.imageLimit) {
      result = { allowed: false, code: 'monthly_image_limit', data };
      return;
    }
    const next = {
      uid, month, tierAtLastUse: policy.tier,
      commands: policy.commandLimit === null ? usedCommands : usedCommands + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (withImage) next.images = policy.imageLimit === null ? usedImages : usedImages + 1;
    tx.set(ref, next, { merge: true });
    result = {
      allowed: true,
      data: { ...data, commands: next.commands, images: withImage ? next.images : usedImages },
    };
  });
  const snapshot = snapshotFromData(policy, result.data || {}, month);
  if (!result.allowed) {
    if (result.code === 'monthly_image_limit') {
      throw quotaError('monthly_image_limit', 'Você atingiu o limite mensal de imagens do Allofy.', snapshot);
    }
    throw quotaError('monthly_command_limit', 'Você atingiu o limite mensal de comandos do Allofy.', snapshot);
  }
  setImmediate(() => maybeSendUsageNotification(uid, profile, 'commands', snapshot));
  return snapshot;
}

async function consumeCommand(uid, profile = {}) {
  return consumeChatRequest(uid, profile, { withImage: false });
}

async function consumeVoiceTranscription(uid, profile = {}) {
  const policy = policyForProfile(profile);
  if (policy.voiceCommandLimit === null) return getUsageSnapshot(uid, profile);
  const month = monthKey();
  const ref = usageRef(uid, month);
  let result;
  await getDb().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data() || {};
    const used = toCounter(data.voiceCommands);
    if (used >= policy.voiceCommandLimit) {
      result = { allowed: false, data };
      return;
    }
    const next = used + 1;
    tx.set(ref, {
      uid, month, tierAtLastUse: policy.tier,
      voiceCommands: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    result = { allowed: true, data: { ...data, voiceCommands: next } };
  });
  const snapshot = snapshotFromData(policy, result.data, month);
  if (!result.allowed) throw quotaError('monthly_voice_limit', 'Você atingiu o limite mensal de comandos por voz.', snapshot);
  return snapshot;
}

async function reserveLiveSession(uid, profile = {}) {
  const policy = policyForProfile(profile);
  if (!policy.features.live) {
    const snapshot = await getUsageSnapshot(uid, profile);
    const error = new Error('O modo ao vivo está disponível no Allofy Pro.');
    error.status = 403;
    error.code = 'pro_required';
    error.usage = snapshot;
    throw error;
  }

  const month = monthKey();
  const ref = usageRef(uid, month);
  const leaseRef = getDb().collection('allofy_live_leases').doc();
  let result;
  await getDb().runTransaction(async tx => {
    const snap = policy.liveSecondsLimit === null ? null : await tx.get(ref);
    const data = snap?.data() || {};
    const used = toCounter(data.liveChargedSeconds);
    const remainingSeconds = policy.liveSecondsLimit === null ? policy.liveSessionMaxSeconds : Math.max(0, policy.liveSecondsLimit - used);
    if (remainingSeconds <= 0) {
      result = { allowed: false, data };
      return;
    }
    const reservedSeconds = Math.max(1, Math.min(policy.liveSessionMaxSeconds, remainingSeconds));
    if (policy.liveSecondsLimit !== null) {
      tx.set(ref, {
        uid, month, tierAtLastUse: policy.tier,
        liveChargedSeconds: used + reservedSeconds,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.set(leaseRef, {
      uid, month, tier: policy.tier,
      reservedSeconds,
      charged: policy.liveSecondsLimit !== null,
      status: 'reserved',
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    result = {
      allowed: true,
      reservedSeconds,
      data: { ...data, liveChargedSeconds: policy.liveSecondsLimit === null ? 0 : used + reservedSeconds },
    };
  });
  const snapshot = snapshotFromData(policy, result.data || {}, month);
  if (!result.allowed) throw quotaError('monthly_live_limit', 'Você atingiu o limite mensal do Allofy Live.', snapshot);
  setImmediate(() => maybeSendUsageNotification(uid, profile, 'live', snapshot));
  return { leaseId: leaseRef.id, maxSeconds: result.reservedSeconds, usage: snapshot };
}

async function finishLiveSession(uid, leaseId, elapsedSeconds) {
  const id = String(leaseId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return { ok: false, code: 'invalid_lease' };
  const leaseRef = getDb().collection('allofy_live_leases').doc(id);
  let final = { ok: false, code: 'not_found' };
  await getDb().runTransaction(async tx => {
    const leaseSnap = await tx.get(leaseRef);
    if (!leaseSnap.exists) return;
    const lease = leaseSnap.data() || {};
    if (String(lease.uid) !== String(uid)) {
      final = { ok: false, code: 'lease_owner_mismatch' };
      return;
    }
    if (lease.status === 'finished' || lease.status === 'cancelled') {
      final = { ok: true, alreadyFinished: true, chargedSeconds: toCounter(lease.chargedSeconds) };
      return;
    }
    const reserved = Math.max(1, toCounter(lease.reservedSeconds));
    const elapsed = Math.max(1, Math.min(reserved, Math.ceil(Number(elapsedSeconds) || reserved)));
    const refund = lease.charged === true ? Math.max(0, reserved - elapsed) : 0;
    if (refund > 0) {
      const ref = usageRef(uid, lease.month || monthKey());
      const usageSnap = await tx.get(ref);
      const current = toCounter(usageSnap.data()?.liveChargedSeconds);
      tx.set(ref, {
        liveChargedSeconds: Math.max(0, current - refund),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.set(leaseRef, {
      status: 'finished',
      chargedSeconds: elapsed,
      refundedSeconds: refund,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    final = { ok: true, chargedSeconds: elapsed, refundedSeconds: refund };
  });
  return final;
}

async function cancelLiveSession(uid, leaseId, reason = 'connection_failed') {
  const id = String(leaseId || '').trim();
  if (!id) return;
  try {
    const leaseRef = getDb().collection('allofy_live_leases').doc(id);
    await getDb().runTransaction(async tx => {
      const snap = await tx.get(leaseRef);
      if (!snap.exists) return;
      const lease = snap.data() || {};
      if (String(lease.uid) !== String(uid) || lease.status !== 'reserved') return;
      const reserved = toCounter(lease.reservedSeconds);
      if (lease.charged === true && reserved > 0) {
        const ref = usageRef(uid, lease.month || monthKey());
        const usageSnap = await tx.get(ref);
        const current = toCounter(usageSnap.data()?.liveChargedSeconds);
        tx.set(ref, { liveChargedSeconds: Math.max(0, current - reserved), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      tx.set(leaseRef, { status: 'cancelled', cancellationReason: String(reason).slice(0, 80), finishedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (error) {
    logger.warn(`Allofy live cancel: ${error.message}`);
  }
}

async function handleUsage(req, res) {
  try {
    res.json(await getUsageSnapshot(req.userIdentity.uid, req.userData || {}));
  } catch (error) {
    logger.error(`Allofy usage: ${error.message}`);
    res.status(503).json({ error: 'Não foi possível carregar os limites do Allofy.' });
  }
}

async function handleFinishLive(req, res) {
  try {
    const result = await finishLiveSession(req.userIdentity.uid, req.body?.leaseId, req.body?.elapsedSeconds);
    res.json(result);
  } catch (error) {
    logger.warn(`Allofy finish live: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível encerrar a franquia da sessão.' });
  }
}

module.exports = {
  TIER,
  policyForProfile,
  getUsageSnapshot,
  consumeChatRequest,
  consumeCommand,
  consumeVoiceTranscription,
  reserveLiveSession,
  finishLiveSession,
  cancelLiveSession,
  handleUsage,
  handleFinishLive,
  snapshotFromData,
  resetAtIso,
};
