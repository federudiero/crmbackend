// lib/firebaseAdmin.js  (ESM)
import admin from "firebase-admin";

const storageBucket = String(
  process.env.FIREBASE_STORAGE_BUCKET || "crmsistem-d3009.firebasestorage.app"
)
  .trim()
  .replace(/^gs:\/\//, "")
  .replace(/\/+$/, "");

if (!globalThis.__ADMIN_APP__) {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
  let sa = null;

  if (saRaw) {
    try {
      sa = JSON.parse(saRaw);
    } catch (e) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT inválido: ${e?.message || e}`);
    }
  }

  const init = {
    storageBucket,
  };

  if (sa) {
    init.credential = admin.credential.cert(sa);
  }

  if (!admin.apps.length) {
    admin.initializeApp(init);
  }

  globalThis.__ADMIN_APP__ = admin.app();
}

export const adminApp = globalThis.__ADMIN_APP__;
export const firestore = admin.firestore();
export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const bucket = admin.storage().bucket(storageBucket);
export default admin;
