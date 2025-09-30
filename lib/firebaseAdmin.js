// lib/firebaseAdmin.js  (ESM)
import admin from "firebase-admin";

if (!globalThis.__ADMIN_APP__) {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      storageBucket: process.env.FB_STORAGE_BUCKET, // crmsistem-d3009.firebasestorage.app
    });
  }
  globalThis.__ADMIN_APP__ = admin.app();
}

export const adminApp = globalThis.__ADMIN_APP__;
export const firestore = admin.firestore();
export const bucket = admin.storage().bucket();
export default admin;