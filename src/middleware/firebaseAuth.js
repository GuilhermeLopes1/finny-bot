const { getDb, admin } = require('../config/firebase');
const logger = require('../utils/logger');
const { hydrateProfile } = require('../services/v39ProfileService');

function requireFirebaseUser(options = {}) {
  return async function firebaseUserMiddleware(req, res, next) {
    try {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) return res.status(401).json({ error: 'Entre novamente para continuar.' });

      const decoded = await admin.auth().verifyIdToken(token, true);
      const snap = await getDb().collection('users').doc(decoded.uid).get();
      const profile = snap.data() || {};
      const isAdmin = profile.role === 'admin' || decoded.admin === true;

      if (profile.banned === true) return res.status(403).json({ error: 'Esta conta está bloqueada.' });
      if (options.requirePro && !profile.isPro && !isAdmin) {
        return res.status(403).json({ error: 'O Allofy está disponível no plano Pro.', code: 'pro_required' });
      }

      const userData = options.dataKeys
        ? await hydrateProfile(decoded.uid, profile, options.dataKeys)
        : profile;
      req.userIdentity = { uid: decoded.uid, email: decoded.email || profile.email || '', isAdmin };
      req.userData = userData;
      next();
    } catch (error) {
      logger.warn(`Firebase auth negada: ${error.message}`);
      res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
    }
  };
}

module.exports = { requireFirebaseUser };
