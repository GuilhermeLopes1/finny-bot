const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

function getDb() {
  return admin.firestore();
}

module.exports = { getDb };
