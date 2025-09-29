// api/simulateImageWebhook.js - Simula un webhook de WhatsApp con imagen
import { db, FieldValue } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);
  
  if (req.method === "OPTIONS") return res.status(204).end();
  
  try {
    console.log("🧪 [simulateImageWebhook] Iniciando simulación de webhook con imagen");
    
    // Simular payload de WhatsApp con imagen
    const simulatedPayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "123456789",
        changes: [{
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15551234567",
              phone_number_id: "123456789012345"
            },
            messages: [{
              from: "5491123456789",
              id: `wamid.${Date.now()}_SIMULATED`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: "image",
              image: {
                caption: "Imagen de prueba simulada",
                mime_type: "image/jpeg",
                sha256: "fake_sha256_hash",
                id: "FAKE_MEDIA_ID_" + Date.now(),
                // Agregamos un link temporal simulado
                link: "https://example.com/fake-image-link"
              }
            }]
          },
          field: "messages"
        }]
      }]
    };
    
    console.log("🧪 [simulateImageWebhook] Payload simulado:", JSON.stringify(simulatedPayload, null, 2));
    
    // Procesar el payload como lo haría el webhook real
    const entry = simulatedPayload.entry[0];
    const change = entry.changes[0];
    const value = change.value;
    const message = value.messages[0];
    
    console.log("🧪 [simulateImageWebhook] Procesando mensaje:", {
      from: message.from,
      id: message.id,
      type: message.type,
      hasImage: !!message.image,
      imageId: message.image?.id,
      imageLink: message.image?.link
    });
    
    // Normalizar número
    const convId = `+${message.from.replace(/\D/g, '')}`;
    const waMessageId = message.id;
    const tsSec = Number(message.timestamp);
    const text = message.image?.caption || "";
    
    console.log("🧪 [simulateImageWebhook] Datos normalizados:", {
      convId,
      waMessageId,
      text
    });
    
    // Crear/actualizar contacto
    const contactRef = db.collection("contacts").doc(convId);
    const contactData = {
      phone: convId,
      waId: message.from.replace(/\D/g, '').slice(1),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await contactRef.set(contactData, { merge: true });
    console.log("🧪 [simulateImageWebhook] Contacto actualizado");
    
    // Crear/actualizar conversación
    const convRef = db.collection("conversations").doc(convId);
    const baseConv = {
      contactId: convId,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastInboundPhoneId: value.metadata.phone_number_id,
      lastInboundDisplay: value.metadata.display_phone_number,
    };
    await convRef.set(baseConv, { merge: true });
    console.log("🧪 [simulateImageWebhook] Conversación actualizada");
    
    // Crear mensaje con imagen (simulando fallo de fetchMedia)
    const messageData = {
      direction: "in",
      type: "image",
      text,
      timestamp: new Date(tsSec * 1000),
      businessPhoneId: value.metadata.phone_number_id,
      businessDisplay: value.metadata.display_phone_number,
      raw: message,
    };
    
    // Simular que fetchMedia falla pero tenemos link
    const imgLink = message.image?.link;
    if (imgLink) {
      messageData.media = {
        kind: "image",
        path: null,
        url: imgLink,
        mime: message.image?.mime_type,
      };
      messageData.mediaUrl = imgLink;
      console.log("🧪 [simulateImageWebhook] Usando link directo:", imgLink);
    } else {
      // Simular fallo total
      messageData.media = { kind: "image" };
      messageData.hasMedia = true;
      messageData.mediaError = "URL_NOT_AVAILABLE";
      console.log("🧪 [simulateImageWebhook] Simulando fallo total de media");
    }
    
    // Guardar mensaje
    await convRef.collection("messages").doc(waMessageId).set(messageData, { merge: true });
    console.log("🧪 [simulateImageWebhook] Mensaje guardado:", {
      waMessageId,
      type: messageData.type,
      hasMedia: !!messageData.media,
      mediaUrl: messageData.mediaUrl,
      mediaError: messageData.mediaError
    });
    
    return res.status(200).json({
      status: "SUCCESS",
      message: "Webhook simulado procesado correctamente",
      data: {
        convId,
        waMessageId,
        messageType: messageData.type,
        hasMedia: !!messageData.media,
        mediaUrl: messageData.mediaUrl,
        mediaError: messageData.mediaError
      }
    });
    
  } catch (error) {
    console.error("❌ [simulateImageWebhook] Error:", error);
    console.error("❌ [simulateImageWebhook] Stack:", error.stack);
    
    return res.status(500).json({
      status: "ERROR",
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}