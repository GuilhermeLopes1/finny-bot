const crypto = require('crypto');
const { getDb, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const DEVICE_COLLECTION = 'notification_devices';
const VOICE_KEY_BYTES = 32;

function validNativeInstallId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim());
}

function nativeDeviceDocumentId(installId) {
  return crypto.createHash('sha256').update(String(installId)).digest('hex').slice(0, 48);
}

function hashVoiceKey(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function appSupportsVoiceWidget(appVersion) {
  const parts = String(appVersion || '').trim().split('.').map(v => Number.parseInt(v, 10));
  if (!Number.isFinite(parts[0])) return false;
  const [major = 0, minor = 0] = parts;
  return major > 1 || (major === 1 && minor >= 4);
}

function constantTimeHexEqual(a, b) {
  if (!/^[0-9a-f]{64}$/i.test(String(a || '')) || !/^[0-9a-f]{64}$/i.test(String(b || ''))) return false;
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function provisionVoiceKeyForDevice(deviceRef, device, options = {}) {
  if (!deviceRef || !device || !device.userId || !device.token || !appSupportsVoiceWidget(device.appVersion)) {
    return { provisioned: false, reason: 'unsupported_or_unbound' };
  }

  const existing = (await deviceRef.get()).data() || {};
  if (existing.voiceKeyHash && options.force !== true) {
    return { provisioned: false, reason: 'already_provisioned' };
  }

  const rawKey = crypto.randomBytes(VOICE_KEY_BYTES).toString('base64url');
  const keyHash = hashVoiceKey(rawKey);
  const issuedAt = new Date().toISOString();

  try {
    await admin.messaging().send({
      token: device.token,
      data: {
        action: 'provision_allofy_voice_key',
        voiceDeviceKey: rawKey,
        installId: String(device.installId || ''),
        voiceKeyVersion: '1',
      },
      android: { priority: 'high' },
    });

    await deviceRef.set({
      voiceKeyHash: keyHash,
      voiceKeyVersion: 1,
      voiceKeyIssuedAt: issuedAt,
      voiceEnabled: true,
      voiceLastProvisionRequestAt: issuedAt,
    }, { merge: true });

    logger.info(`Allofy Voice: credencial provisionada para device ${deviceRef.id.slice(0, 10)}…`);
    return { provisioned: true };
  } catch (error) {
    logger.warn(`Allofy Voice: falha ao provisionar credencial FCM: ${error.message}`);
    return { provisioned: false, reason: 'fcm_failed' };
  }
}

async function authenticateNativeVoiceRequest(req, res, next) {
  try {
    const installId = String(req.headers['x-allofy-install-id'] || req.body?.installId || '').trim();
    const deviceKey = String(req.headers['x-allofy-device-key'] || req.body?.deviceKey || '').trim();
    if (!validNativeInstallId(installId) || deviceKey.length < 32 || deviceKey.length > 256) {
      return res.status(401).json({ error: 'Widget de voz não autorizado.', code: 'voice_device_unauthorized' });
    }

    const ref = getDb().collection(DEVICE_COLLECTION).doc(nativeDeviceDocumentId(installId));
    const snap = await ref.get();
    const device = snap.data() || {};
    const suppliedHash = hashVoiceKey(deviceKey);

    if (!snap.exists || !device.userId || !constantTimeHexEqual(device.voiceKeyHash, suppliedHash)) {
      return res.status(401).json({ error: 'Widget de voz precisa ser vinculado novamente.', code: 'voice_device_rebind_required' });
    }
    if (device.voiceEnabled === false) {
      return res.status(403).json({ error: 'Voz desativada neste aparelho.', code: 'voice_device_disabled' });
    }

    const userSnap = await getDb().collection('users').doc(device.userId).get();
    const profile = userSnap.data() || {};
    const isAdmin = profile.role === 'admin' || profile.isAdmin === true;
    if (!userSnap.exists || profile.banned === true) {
      return res.status(403).json({ error: 'Conta indisponível.', code: 'account_unavailable' });
    }
    if (!profile.isPro && !isAdmin) {
      return res.status(403).json({ error: 'O modo de voz ao vivo está disponível no plano Pro.', code: 'pro_required' });
    }

    req.userIdentity = { uid: device.userId, email: profile.email || '', isAdmin, nativeVoice: true };
    req.userData = profile;
    req.nativeVoiceDevice = { installId, ref, device };
    await ref.set({ voiceLastUsedAt: new Date().toISOString() }, { merge: true });
    return next();
  } catch (error) {
    logger.warn(`Allofy Voice auth falhou: ${error.message}`);
    return res.status(401).json({ error: 'Não foi possível autenticar o widget de voz.', code: 'voice_device_auth_failed' });
  }
}

module.exports = {
  validNativeInstallId,
  nativeDeviceDocumentId,
  appSupportsVoiceWidget,
  provisionVoiceKeyForDevice,
  authenticateNativeVoiceRequest,
};
