// api/debugEnv.js
export default function handler(req, res) {
  res.json({
    tokenSet: !!process.env.META_WA_TOKEN,
    phoneIdSet: !!process.env.META_WA_PHONE_ID,
    verifySet: !!process.env.META_WA_VERIFY_TOKEN,
    firebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
    firebaseClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    firebasePrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    firebaseStorageBucket: !!process.env.FIREBASE_STORAGE_BUCKET,
    firebaseServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
  });
}
