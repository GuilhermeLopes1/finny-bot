const {
  initializeApp,
  cert,
  getApps,
} = require('firebase-admin/app');

const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');

const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

if (!process.env.GOOGLE_CREDENTIALS) {
  throw new Error(
    'A variável GOOGLE_CREDENTIALS não foi configurada no Render.'
  );
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (error) {
  throw new Error(
    `GOOGLE_CREDENTIALS contém um JSON inválido: ${error.message}`
  );
}

// Corrige as quebras de linha da chave privada
if (serviceAccount.private_key) {
  serviceAccount.private_key =
    serviceAccount.private_key.replace(/\\n/g, '\n');
}

console.log(
  '🔥 PROJECT ID BACK:',
  serviceAccount.project_id
);

const firebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

const db = getFirestore(firebaseApp);

console.log('🔥 Firebase conectado');

// Mantém compatibilidade com os outros arquivos do projeto
function firestore() {
  return db;
}

firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

const admin = {
  firestore,
  auth: () => getAuth(firebaseApp),
  messaging: () => getMessaging(firebaseApp),
  app: () => firebaseApp,
};

function getDb() {
  return db;
}

module.exports = {
  getDb,
  admin,
  firebaseApp,
};
