const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// 🔐 Corrige quebra de linha da chave privada
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("🔥 Firebase conectado");
}

const db = admin.firestore();

function getDb() {
  return db;
}

module.exports = { getDb, admin };
