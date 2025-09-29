// api/createTestImageMessage.js — Crear mensaje de imagen de prueba para frontend
import { db, FieldValue } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);
  
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const conversationId = "+5491123456789"; // Usar la conversación existente
    const messageId = `test_image_${Date.now()}`;
    
    // URL de imagen de prueba (una imagen pública de ejemplo)
    const testImageUrl = "https://picsum.photos/400/300";
    
    const messageData = {
      id: messageId,
      direction: "in",
      type: "image",
      text: "Imagen de prueba para verificar visualización en frontend",
      timestamp: new Date(),
      media: {
        kind: "image",
        url: testImageUrl,
        path: `test/${messageId}.jpg`
      },
      mediaUrl: testImageUrl, // Fallback
      image: {
        url: testImageUrl,
        link: testImageUrl
      },
      businessPhoneId: "test_phone_id",
      raw: {
        type: "image",
        image: {
          id: "test_image_id",
          mime_type: "image/jpeg",
          caption: "Imagen de prueba para verificar visualización en frontend"
        }
      }
    };

    // Guardar en la conversación existente
    const convRef = db.collection("conversations").doc(conversationId);
    await convRef.collection("messages").doc(messageId).set(messageData);

    // También actualizar la conversación
    await convRef.set({
      lastMessageAt: FieldValue.serverTimestamp(),
      contactId: conversationId
    }, { merge: true });

    console.log("✅ Test image message created:", {
      conversationId,
      messageId,
      imageUrl: testImageUrl
    });

    return res.status(200).json({
      success: true,
      message: "Test image message created successfully",
      data: {
        conversationId,
        messageId,
        imageUrl: testImageUrl,
        messageData
      }
    });
    
  } catch (error) {
    console.error("❌ Error creating test image message:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to create test image message"
    });
  }
}