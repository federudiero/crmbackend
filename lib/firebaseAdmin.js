import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: process.env.FB_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    // 👇 Agregá tu bucket, ej: crmsistem.appspot.com
    storageBucket: process.env.FB_STORAGE_BUCKET,
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const bucket = admin.storage().bucket();