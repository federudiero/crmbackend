import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: process.env.FB_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    storageBucket: process.env.FB_STORAGE_BUCKET || "crmsistem-d3009.appspot.com",
  });
}

export const db = admin.firestore();
export const storage = admin.storage();
export const FieldValue = admin.firestore.FieldValue;