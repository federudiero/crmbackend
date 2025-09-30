// lib/firebaseAdmin.js  (ESM)
import admin from "firebase-admin";

if (!globalThis.__ADMIN_APP__) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  // Bucket correcto para el backend
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || 'crmsistem-d3009.appspot.com';

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      storageBucket: storageBucket,
    });
  }
  globalThis.__ADMIN_APP__ = admin.app();
}

export const adminApp = globalThis.__ADMIN_APP__;
export const firestore = admin.firestore();
// Especificar explícitamente el bucket para evitar errores
export const bucket = admin.storage().bucket('crmsistem-d3009.appspot.com');
export default admin;