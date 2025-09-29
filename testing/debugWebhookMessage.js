import { db } from "../lib/firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🔍 Analizando mensajes reales vs de prueba...');

    // Buscar todos los mensajes de imagen
    const conversationsRef = db.collection('conversations');
    const conversationsSnapshot = await conversationsRef.get();
    
    const allImageMessages = [];

    for (const conversationDoc of conversationsSnapshot.docs) {
      const conversationId = conversationDoc.id;
      const messagesRef = db.collection('conversations').doc(conversationId).collection('messages');
      const messagesSnapshot = await messagesRef.get();
      
      messagesSnapshot.docs.forEach(messageDoc => {
        const messageData = { id: messageDoc.id, ...messageDoc.data() };
        
        // Filtrar solo mensajes de imagen
        if (messageData.type === 'image' || 
            messageData.media?.kind === 'image' || 
            messageData.mediaKind === 'image' ||
            messageData.hasMedia) {
          allImageMessages.push({
            conversationId,
            ...messageData,
            // Análisis de propiedades
            analysis: {
              hasMediaUrl: !!messageData.mediaUrl,
              hasMediaObject: !!messageData.media,
              hasMediaUrl_in_media: !!messageData.media?.url,
              hasMediaLink_in_media: !!messageData.media?.link,
              hasImageObject: !!messageData.image,
              hasImageUrl_in_image: !!messageData.image?.url,
              hasImageLink_in_image: !!messageData.image?.link,
              isTestMessage: messageData.id?.includes('test') || messageData.text?.includes('prueba'),
              isRealWhatsAppMessage: messageData.id?.startsWith('wamid.'),
              hasRawData: !!messageData.raw
            }
          });
        }
      });
    }

    // Separar mensajes reales vs de prueba
    const realMessages = allImageMessages.filter(m => m.analysis.isRealWhatsAppMessage);
    const testMessages = allImageMessages.filter(m => m.analysis.isTestMessage);
    const otherMessages = allImageMessages.filter(m => !m.analysis.isRealWhatsAppMessage && !m.analysis.isTestMessage);

    console.log(`📊 Encontrados: ${realMessages.length} reales, ${testMessages.length} de prueba, ${otherMessages.length} otros`);

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'SUCCESS',
      summary: {
        total_image_messages: allImageMessages.length,
        real_whatsapp_messages: realMessages.length,
        test_messages: testMessages.length,
        other_messages: otherMessages.length
      },
      analysis: {
        real_messages: realMessages.map(m => ({
          id: m.id,
          conversationId: m.conversationId,
          direction: m.direction,
          timestamp: m.timestamp,
          analysis: m.analysis,
          // Solo mostrar propiedades relevantes para debug
          media: m.media,
          mediaUrl: m.mediaUrl,
          image: m.image,
          hasMedia: m.hasMedia,
          mediaKind: m.mediaKind,
          raw_image_data: m.raw?.image // Datos originales del webhook
        })),
        test_messages: testMessages.map(m => ({
          id: m.id,
          conversationId: m.conversationId,
          direction: m.direction,
          analysis: m.analysis,
          media: m.media,
          mediaUrl: m.mediaUrl,
          image: m.image
        }))
      }
    });

  } catch (error) {
    console.error('❌ Error al analizar mensajes:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}