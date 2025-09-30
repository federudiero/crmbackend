// api/testWebhookConnectivity.js - Endpoint para probar la conectividad del webhook
import { db } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);
  
  if (req.method === "OPTIONS") return res.status(204).end();
  
  try {
    console.log("🔍 [testWebhookConnectivity] Iniciando prueba de conectividad");
    console.log("🔍 [testWebhookConnectivity] Method:", req.method);
    console.log("🔍 [testWebhookConnectivity] Headers:", JSON.stringify(req.headers, null, 2));
    console.log("🔍 [testWebhookConnectivity] Body:", JSON.stringify(req.body, null, 2));
    
    // Verificar conexión a Firebase
    const testDoc = await db.collection("test").doc("connectivity").get();
    console.log("🔍 [testWebhookConnectivity] Firebase conectado:", testDoc.exists);
    
    // Verificar variables de entorno críticas
    const envCheck = {
      META_WA_TOKEN: !!process.env.META_WA_TOKEN,
      META_WA_VERIFY_TOKEN: !!process.env.META_WA_VERIFY_TOKEN,
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
    };
    console.log("🔍 [testWebhookConnectivity] Variables de entorno:", envCheck);
    
    // Simular procesamiento de mensaje con imagen
    if (req.method === "POST") {
      const body = req.body || {};
      console.log("🔍 [testWebhookConnectivity] Procesando POST request");
      
      // Verificar estructura del webhook
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      
      console.log("🔍 [testWebhookConnectivity] Estructura webhook:", {
        hasEntry: !!entry,
        hasChange: !!change,
        hasValue: !!value,
        messages: value?.messages?.length || 0,
        statuses: value?.statuses?.length || 0
      });
      
      if (value?.messages) {
        for (const m of value.messages) {
          console.log("🔍 [testWebhookConnectivity] Mensaje recibido:", {
            id: m.id,
            type: m.type,
            from: m.from,
            hasImage: !!m.image,
            imageId: m.image?.id,
            imageLink: m.image?.link
          });
        }
      }
    }
    
    const response = {
      status: "OK",
      timestamp: new Date().toISOString(),
      method: req.method,
      firebase: testDoc.exists,
      env: envCheck,
      message: "Webhook connectivity test successful"
    };
    
    console.log("🔍 [testWebhookConnectivity] Respuesta:", response);
    return res.status(200).json(response);
    
  } catch (error) {
    console.error("❌ [testWebhookConnectivity] Error:", error);
    console.error("❌ [testWebhookConnectivity] Stack:", error.stack);
    
    return res.status(500).json({
      status: "ERROR",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}