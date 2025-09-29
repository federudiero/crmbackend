// api/testFrontendImages.js — Endpoint para obtener mensajes con imágenes para probar frontend
import { db } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);
  
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    console.log("🔍 Searching for image messages in database...");
    
    // Buscar conversaciones con mensajes de imagen
    const conversationsSnapshot = await db.collection("conversations").limit(10).get();
    let imageMessages = [];
    let conversationsWithImages = [];
    
    for (const convDoc of conversationsSnapshot.docs) {
      const convId = convDoc.id;
      const convData = convDoc.data();
      
      // Buscar mensajes con imágenes en esta conversación
      const messagesSnapshot = await convDoc.ref
        .collection("messages")
        .where("type", "==", "image")
        .limit(5)
        .get();
      
      if (!messagesSnapshot.empty) {
        const messages = [];
        messagesSnapshot.docs.forEach(msgDoc => {
          const data = msgDoc.data();
          messages.push({
            id: msgDoc.id,
            type: data.type,
            direction: data.direction,
            timestamp: data.timestamp?.toDate?.()?.toISOString() || data.timestamp,
            media: data.media,
            mediaUrl: data.mediaUrl,
            image: data.image,
            hasMedia: !!data.media,
            mediaKind: data.media?.kind,
            mediaUrl_resolved: data.media?.url || data.media?.link || data.mediaUrl || data.image?.link || data.image?.url,
            text: data.text || data.image?.caption || ""
          });
        });
        
        conversationsWithImages.push({
          conversationId: convId,
          contactId: convData.contactId,
          lastMessageAt: convData.lastMessageAt?.toDate?.()?.toISOString() || convData.lastMessageAt,
          messageCount: messages.length,
          messages
        });
        
        imageMessages.push(...messages);
      }
    }

    const response = {
      timestamp: new Date().toISOString(),
      status: "SUCCESS",
      summary: {
        total_conversations_checked: conversationsSnapshot.size,
        conversations_with_images: conversationsWithImages.length,
        total_image_messages: imageMessages.length
      },
      conversations: conversationsWithImages,
      sample_messages: imageMessages.slice(0, 10) // Primeros 10 mensajes como muestra
    };

    console.log("🔍 Search completed:", {
      conversations_checked: conversationsSnapshot.size,
      conversations_with_images: conversationsWithImages.length,
      total_image_messages: imageMessages.length
    });

    return res.status(200).json(response);
    
  } catch (error) {
    console.error("❌ Error searching for image messages:", error);
    return res.status(500).json({
      timestamp: new Date().toISOString(),
      status: "ERROR",
      error: error.message,
      message: "Failed to search for image messages"
    });
  }
}