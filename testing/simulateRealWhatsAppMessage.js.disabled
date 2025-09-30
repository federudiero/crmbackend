import { db, FieldValue } from "../lib/firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🧪 Simulando mensaje real de WhatsApp...');

    // Simular estructura de mensaje real de WhatsApp (sin URL válida)
    const realWhatsAppMessage = {
      id: `wamid.test_real_${Date.now()}`,
      type: "image",
      direction: "incoming",
      text: "",
      timestamp: new Date(),
      businessPhoneId: "768483333020913",
      businessDisplay: "Test Business",
      hasMedia: true,
      media: {
        kind: "image"
        // Nota: NO tiene url ni link - esto simula el problema real
      },
      mediaError: "URL_NOT_AVAILABLE",
      raw: {
        id: `wamid.test_real_${Date.now()}`,
        type: "image",
        timestamp: Math.floor(Date.now() / 1000),
        from: "5493518120950",
        image: {
          id: "fake_media_id_123",
          mime_type: "image/jpeg",
          sha256: "fake_sha256_hash"
          // Nota: NO tiene link - esto es lo que pasa en mensajes reales
        }
      }
    };

    // Simular mensaje de prueba (con URL válida)
    const testMessage = {
      id: `test_comparison_${Date.now()}`,
      type: "image",
      direction: "incoming", 
      text: "Imagen de prueba",
      timestamp: new Date(),
      businessPhoneId: "768483333020913",
      businessDisplay: "Test Business",
      hasMedia: true,
      media: {
        kind: "image",
        url: "https://picsum.photos/400/300"
      },
      mediaUrl: "https://picsum.photos/400/300"
    };

    // Usar conversación existente o crear una nueva
    const conversationId = "test_conversation_comparison";
    
    // Guardar ambos mensajes
    const messagesRef = db.collection('conversations').doc(conversationId).collection('messages');
    
    await messagesRef.doc(realWhatsAppMessage.id).set(realWhatsAppMessage);
    await messagesRef.doc(testMessage.id).set(testMessage);

    // Actualizar conversación
    await db.collection('conversations').doc(conversationId).set({
      id: conversationId,
      customerPhone: "5493518120950",
      customerName: "Cliente Prueba Comparación",
      lastMessage: "Comparación: mensaje real vs prueba",
      lastMessageTime: FieldValue.serverTimestamp(),
      unreadCount: 2,
      status: "active",
      assignedTo: null,
      tags: ["test", "comparison"],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log('✅ Mensajes de comparación creados');

    return res.status(200).json({
      success: true,
      conversationId,
      messages: {
        realWhatsApp: {
          id: realWhatsAppMessage.id,
          hasMediaUrl: !!realWhatsAppMessage.mediaUrl,
          hasMediaObject: !!realWhatsAppMessage.media,
          hasMediaUrlInMedia: !!realWhatsAppMessage.media?.url,
          mediaError: realWhatsAppMessage.mediaError
        },
        testMessage: {
          id: testMessage.id,
          hasMediaUrl: !!testMessage.mediaUrl,
          hasMediaObject: !!testMessage.media,
          hasMediaUrlInMedia: !!testMessage.media?.url
        }
      },
      analysis: {
        realMessage_structure: realWhatsAppMessage,
        testMessage_structure: testMessage
      }
    });

  } catch (error) {
    console.error('❌ Error al simular mensajes:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}