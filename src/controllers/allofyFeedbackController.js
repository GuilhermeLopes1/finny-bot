const crypto = require('crypto');
const { getDb, admin } = require('../config/firebase');
const logger = require('../utils/logger');

const ALLOWED_KINDS = new Set(['helpful', 'not_helpful', 'report']);
const ALLOWED_SOURCES = new Set(['text', 'voice', 'live', 'widget', 'widget_live']);

function clean(value, max) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function handleAllofyFeedback(req, res) {
  const kind = clean(req.body?.kind, 30);
  const source = ALLOWED_SOURCES.has(clean(req.body?.source, 30)) ? clean(req.body?.source, 30) : 'text';
  const content = clean(req.body?.content, 12000);
  const note = clean(req.body?.note, 1000);
  if (!ALLOWED_KINDS.has(kind)) return res.status(400).json({ error: 'Tipo de feedback inválido.' });
  if (!content && kind === 'report') return res.status(400).json({ error: 'Conteúdo obrigatório para denúncia.' });

  try {
    const uid = req.userIdentity.uid;
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    await getDb().collection('allofy_ai_feedback').add({
      uid,
      kind,
      source,
      content: content.slice(0, kind === 'report' ? 12000 : 4000),
      contentHash,
      note,
      status: kind === 'report' ? 'pending_review' : 'received',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtIso: new Date().toISOString(),
    });
    return res.json({ ok: true });
  } catch (error) {
    logger.warn(`Allofy feedback: ${error.message}`);
    return res.status(500).json({ error: 'Não foi possível enviar o feedback agora.' });
  }
}

module.exports = { handleAllofyFeedback, ALLOWED_KINDS, ALLOWED_SOURCES };
