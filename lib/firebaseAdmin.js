// lib/firebaseAdmin.js  (ESM)
import admin from "firebase-admin";

const storageBucket = String(
  process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.GCLOUD_STORAGE_BUCKET ||
    "crmsistem-d3009.firebasestorage.app"
)
  .trim()
  .replace(/^gs:\/\//, "")
  .replace(/\/+$/, "");

if (!globalThis.__ADMIN_APP__) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  const init = {
    storageBucket,
  };

  if (sa) {
    init.credential = admin.credential.cert(sa);
  } else {
    init.credential = admin.credential.applicationDefault();
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
