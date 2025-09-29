// api/handleExpiredMedia.js
// Endpoint para manejar imágenes con IDs de media expirados

import { db } from '../firebase.js';
import { collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';

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