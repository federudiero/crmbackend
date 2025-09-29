// api/findSpecificMessage.js — Buscar mensaje específico por ID
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
    const { messageId } = req.query;
    
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: "messageId parameter is required"
      });
    }

    console.log("🔍 Searching for message:", messageId);

    // Buscar en todas las conversaciones
    const conversationsSnapshot = await db.collection("conversations").get();
    let foundMessage = null;
    let foundConversationId = null;

    for (const convDoc of conversationsSnapshot.docs) {
      const messagesSnapshot = await convDoc.ref.collection("messages")
        .where("id", "==", messageId)
        .limit(1)
        .get();
      
      if (!messagesSnapshot.empty) {
        foundMessage = messagesSnapshot.docs[0].data();
        foundConversationId = convDoc.id;
        break;
      }
    }

    if (!foundMessage) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
        messageId
      });
    }

    console.log("✅ Found message:", {
      conversationId: foundConversationId,
      messageId,
      type: foundMessage.type,
      hasMedia: foundMessage.hasMedia,
      mediaKind: foundMessage.mediaKind,
      mediaUrl: foundMessage.mediaUrl,
      media: foundMessage.media,
      image: foundMessage.image,
      audio: foundMessage.audio
    });

    return res.status(200).json({
      success: true,
      conversationId: foundConversationId,
      message: foundMessage,
      analysis: {
        type: foundMessage.type,
        hasMedia: foundMessage.hasMedia,
        mediaKind: foundMessage.mediaKind,
        mediaUrl: foundMessage.mediaUrl,
        mediaObject: foundMessage.media,
        imageObject: foundMessage.image,
        audioObject: foundMessage.audio,
        possibleUrls: {
          "media.url": foundMessage.media?.url,
          "media.link": foundMessage.media?.link,
          "mediaUrl": foundMessage.mediaUrl,
          "image.url": foundMessage.image?.url,
          "image.link": foundMessage.image?.link,
          "audio.url": foundMessage.audio?.url,
          "audio.link": foundMessage.audio?.link
        }
      }
    });
    
  } catch (error) {
    console.error("❌ Error finding message:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}