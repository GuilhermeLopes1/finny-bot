const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();

async function saveTransaction(userId, transaction) {
  await db.collection("users").doc(userId).set({
    transactions: admin.firestore.FieldValue.arrayUnion(transaction)
  }, { merge: true });

  console.log("💾 Transação salva:", transaction);
}

module.exports = { saveTransaction };
