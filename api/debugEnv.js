// api/debugEnv.js - Updated for Firebase debug
export default function handler(req, res) {
  const envStatus = {
    // WhatsApp variables
    tokenSet: !!process.env.WHATSAPP_TOKEN,
    phoneIdSet: !!process.env.PHONE_NUMBER_ID,
    verifySet: !!process.env.VERIFY_TOKEN,
    
    // Firebase variables (nuevas)
    firebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
    firebaseClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    firebasePrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    firebaseStorageBucket: !!process.env.FIREBASE_STORAGE_BUCKET,
    firebaseServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    
    // Firebase variables (viejas - para verificar)
    fbProjectId: !!process.env.FB_PROJECT_ID,
    fbClientEmail: !!process.env.FB_CLIENT_EMAIL,
    fbPrivateKey: !!process.env.FB_PRIVATE_KEY,
    
    // Valores reales (solo primeros caracteres para debug)
    firebaseProjectIdValue: process.env.FIREBASE_PROJECT_ID?.substring(0, 10) + '...',
    fbProjectIdValue: process.env.FB_PROJECT_ID?.substring(0, 10) + '...',
  };

  res.status(200).json(envStatus);
}
