// api/checkWebhookLogs.js
// Endpoint para verificar logs recientes del webhook y detectar problemas con imágenes

import admin from 'firebase-admin';

// Inicializar Firebase Admin si no está inicializado
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FB_PROJECT_ID}.firebaseio.com`
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  console.log('🔍 [checkWebhookLogs] Iniciando verificación de logs del webhook');
  
  try {
    // Buscar mensajes recientes con imágenes
    const messagesRef = db.collection('messages');
    const imageQuery = messagesRef
      .where('type', '==', 'image')
      .orderBy('timestamp', 'desc')
      .limit(10);

    const querySnapshot = await imageQuery.get();
    const imageMessages = [];
    
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      imageMessages.push({
        id: doc.id,
        waMessageId: data.waMessageId,
        timestamp: data.timestamp,
        hasMedia: data.hasMedia,
        mediaUrl: data.mediaUrl,
        mediaError: data.mediaError,
        media: data.media,
        from: data.from,
        conversationId: data.conversationId
      });
    });

    console.log(`📊 [checkWebhookLogs] Encontrados ${imageMessages.length} mensajes de imagen recientes`);

    // Analizar problemas comunes
    const analysis = {
      totalImages: imageMessages.length,
      withValidUrl: imageMessages.filter(m => m.mediaUrl && !m.mediaError).length,
      withErrors: imageMessages.filter(m => m.mediaError).length,
      withoutUrl: imageMessages.filter(m => !m.mediaUrl).length,
      recentMessages: imageMessages.slice(0, 5)
    };

    console.log('📋 [checkWebhookLogs] Análisis:', JSON.stringify(analysis, null, 2));

    // Buscar conversaciones recientes para verificar conectividad
    const conversationsRef = db.collection('conversations');
    const recentConversations = conversationsRef
      .orderBy('lastMessageTime', 'desc')
      .limit(5);

    const conversationsSnapshot = await recentConversations.get();
    const conversations = [];
    
    conversationsSnapshot.forEach((doc) => {
      const data = doc.data();
      conversations.push({
        id: doc.id,
        phoneNumber: data.phoneNumber,
        lastMessageTime: data.lastMessageTime,
        lastMessageType: data.lastMessageType
      });
    });

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      analysis,
      recentConversations: conversations,
      recommendations: generateRecommendations(analysis)
    });

  } catch (error) {
    console.error('💥 [checkWebhookLogs] Error:', error);
    res.status(500).json({
      error: 'Error verificando logs del webhook',
      details: error.message
    });
  }
}

function generateRecommendations(analysis) {
  const recommendations = [];
  
  if (analysis.totalImages === 0) {
    recommendations.push("No se encontraron mensajes de imagen recientes. Verificar si WhatsApp está enviando webhooks.");
  }
  
  if (analysis.withErrors > 0) {
    recommendations.push(`${analysis.withErrors} mensajes tienen errores de media. Verificar token de WhatsApp API.`);
  }
  
  if (analysis.withoutUrl > 0) {
    recommendations.push(`${analysis.withoutUrl} mensajes no tienen URL de media. Verificar proceso de descarga.`);
  }
  
  if (analysis.withValidUrl === analysis.totalImages && analysis.totalImages > 0) {
    recommendations.push("✅ Todos los mensajes de imagen tienen URLs válidas.");
  }
  
  return recommendations;
}