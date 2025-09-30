// lib/firebaseAdmin.js (Node ESM)
import * as admin from "firebase-admin";

if (!globalThis.__FIREBASE_ADMIN__) {
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saRaw) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
  let serviceAccount;
  try { serviceAccount = JSON.parse(saRaw); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"); }

  if (!serviceAccount.project_id) {
    throw new Error('Service account object must contain a string "project_id" property.');
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // ver punto 2
    });
  }
  globalThis.__FIREBASE_ADMIN__ = {
    admin,
    db: admin.firestore(),
    storage: admin.storage(),
    FieldValue: admin.firestore.FieldValue,
  };
}

export const { admin, db, storage, FieldValue } = globalThis.__FIREBASE_ADMIN__;
