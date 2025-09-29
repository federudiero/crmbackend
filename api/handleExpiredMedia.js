// api/handleExpiredMedia.js
// Endpoint para manejar imágenes con IDs de media expirados

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';

// Configuración Firebase
const firebaseConfig = {
  apiKey: process.env.FB_API_KEY,
  authDomain: process.env.FB_AUTH_DOMAIN,
  projectId: process.env.FB_PROJECT_ID,
  storageBucket: process.env.FB_STORAGE_BUCKET,
  messagingSenderId: process.env.FB_MESSAGING_SENDER_ID,
  appId: process.env.FB_APP_ID
};

// Inicializar Firebase solo si no existe
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🔧 [handleExpiredMedia] Iniciando proceso de limpieza...');

    // Buscar mensajes con mediaError: "URL_NOT_AVAILABLE"
    const messagesRef = collection(db, 'messages');
    const expiredQuery = query(
      messagesRef,
      where('mediaError', '==', 'URL_NOT_AVAILABLE'),
      where('hasMedia', '==', true)
    );

    const expiredSnapshot = await getDocs(expiredQuery);
    const expiredMessages = expiredSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`📊 [handleExpiredMedia] Encontrados ${expiredMessages.length} mensajes con media expirada`);

    let updatedCount = 0;
    let errorCount = 0;

    // Procesar cada mensaje expirado
    for (const message of expiredMessages) {
      try {
        const messageRef = doc(db, 'messages', message.id);
        
        // Marcar como media no disponible permanentemente
        await updateDoc(messageRef, {
          mediaStatus: 'expired',
          mediaError: 'MEDIA_EXPIRED',
          mediaExpiredAt: new Date(),
          // Mantener información básica para mostrar placeholder
          mediaPlaceholder: {
            type: message.mediaKind || message.type || 'image',
            originalId: message.media?.id || message.image?.id,
            expiredReason: 'WhatsApp media ID expired (24-48h limit)'
          }
        });

        updatedCount++;
        console.log(`✅ [handleExpiredMedia] Actualizado mensaje ${message.id}`);

      } catch (error) {
        errorCount++;
        console.error(`❌ [handleExpiredMedia] Error actualizando ${message.id}:`, error);
      }
    }

    // Estadísticas finales
    const stats = {
      totalExpired: expiredMessages.length,
      updated: updatedCount,
      errors: errorCount,
      timestamp: new Date().toISOString()
    };

    console.log('📈 [handleExpiredMedia] Estadísticas finales:', stats);

    res.status(200).json({
      success: true,
      message: `Procesados ${updatedCount} mensajes con media expirada`,
      stats
    });

  } catch (error) {
    console.error('💥 [handleExpiredMedia] Error general:', error);
    res.status(500).json({
      error: 'Error procesando media expirada',
      details: error.message
    });
  }
}