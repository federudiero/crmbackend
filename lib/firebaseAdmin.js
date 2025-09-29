// lib/firebaseAdmin.js
import admin from "firebase-admin";
// lib/firebaseAdmin.js
import admin from "firebase-admin";

if (!admin.apps.length) {
  const projectId  = process.env.FB_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FB_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = (process.env.FB_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    storageBucket:
      process.env.FB_STORAGE_BUCKET ||
      process.env.FIREBASE_STORAGE_BUCKET ||
      `${projectId}.firebasestorage.app`,
  });
}

export const db = admin.firestore();
// 👇 ESTA línea debe ejecutarse en prod
db.settings({ ignoreUndefinedProperties: true });
console.log("[FB] Firestore settings: ignoreUndefinedProperties=ON");

export const FieldValue = admin.firestore.FieldValue;
export const bucket = admin.storage().bucket();