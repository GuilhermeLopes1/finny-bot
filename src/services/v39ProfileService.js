function firebase() { return require('../config/firebase'); }

const V39_DATA_KEYS = [
  'transactions', 'banks', 'cards', 'categories', 'goals', 'debts', 'benefits',
  'calculatorSimulations', 'importHistory', 'cofres', 'uberJornadas', 'uberCorridas',
  'uberGastos', 'uberAbastec', 'uberVeiculos', 'cardTransactions',
];

function stableHash(value) {
  let text;
  try { text = JSON.stringify(value ?? null); } catch (_) { text = String(value ?? ''); }
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function safeDocId(item, index, used = new Set()) {
  let base = item?.id || item?.transactionId || item?.batchId || '';
  base = String(base).trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 110);
  if (!base) base = `legacy_${index}_${stableHash(item).split(':').pop()}`;
  let id = base;
  let suffix = 1;
  while (used.has(id)) id = `${base}_${suffix++}`;
  used.add(id);
  return id;
}

function cleanCollectionDocument(doc) {
  const value = { ...doc.data() };
  const order = Number(value._v39Order ?? 0);
  delete value._v39Order;
  return { order, value };
}

async function readV39Collection(userRef, key) {
  const snapshot = await userRef.collection(key).get();
  return snapshot.docs
    .map(cleanCollectionDocument)
    .sort((a, b) => a.order - b.order)
    .map(row => row.value);
}

async function hydrateProfile(uid, rootProfile = null, keys = V39_DATA_KEYS) {
  const userRef = firebase().getDb().collection('users').doc(uid);
  let profile = rootProfile;
  if (!profile) {
    const snap = await userRef.get();
    if (!snap.exists) throw new Error('Perfil financeiro não encontrado');
    profile = snap.data() || {};
  }
  const output = { ...profile };
  const selected = keys.filter(key => V39_DATA_KEYS.includes(key));
  const loaded = await Promise.all(selected.map(async key => {
    const items = await readV39Collection(userRef, key);
    const migrated = Number(profile.dataSchemaVersion || 0) >= 39;
    return [key, migrated ? items : (Array.isArray(profile[key]) ? profile[key] : items)];
  }));
  loaded.forEach(([key, items]) => { output[key] = items; });
  return output;
}

async function commitOperations(db, operations) {
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = db.batch();
    operations.slice(offset, offset + 400).forEach(operation => {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data, { merge: false });
    });
    await batch.commit();
  }
}

async function migrateLegacyProfileV39(uid, rootProfile = null) {
  const db = firebase().getDb();
  const userRef = db.collection('users').doc(uid);
  let profile = rootProfile;
  if (!profile) {
    const snap = await userRef.get();
    if (!snap.exists) throw new Error('Perfil financeiro não encontrado');
    profile = snap.data() || {};
  }
  if (Number(profile.dataSchemaVersion || 0) >= 39) return hydrateProfile(uid, profile);

  // Copia primeiro todos os arrays. O documento raiz só é limpo após todos os batches concluírem.
  for (const key of V39_DATA_KEYS) {
    const items = Array.isArray(profile[key]) ? profile[key] : [];
    const existing = await userRef.collection(key).get();
    const existingIds = new Set(existing.docs.map(doc => doc.id));
    const desiredIds = new Set();
    const used = new Set();
    const operations = [];
    items.forEach((item, index) => {
      const id = safeDocId(item, index, used);
      desiredIds.add(id);
      const data = JSON.parse(JSON.stringify(item ?? {}));
      data._v39Order = index;
      operations.push({ type: 'set', ref: userRef.collection(key).doc(id), data });
    });
    existingIds.forEach(id => {
      if (!desiredIds.has(id)) operations.push({ type: 'delete', ref: userRef.collection(key).doc(id) });
    });
    await commitOperations(db, operations);
  }

  const rootUpdate = {
    dataSchemaVersion: 39,
    dataMigratedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  V39_DATA_KEYS.forEach(key => { rootUpdate[key] = firebase().admin.firestore.FieldValue.delete(); });
  await userRef.set(rootUpdate, { merge: true });
  return hydrateProfile(uid, { ...profile, dataSchemaVersion: 39 });
}

module.exports = {
  V39_DATA_KEYS,
  stableHash,
  safeDocId,
  readV39Collection,
  hydrateProfile,
  migrateLegacyProfileV39,
};
