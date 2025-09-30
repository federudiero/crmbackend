// api/handleExpiredMedia.js
import admin from "../lib/firebaseAdmin.js";

const db = admin.firestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Buscar mensajes con media_id expirado
    const messagesRef = db.collection('messages');
    const q = messagesRef.where('media_id', '==', mediaId);
    const querySnapshot = await q.get();

    if (querySnapshot.empty) {
      return res.status(404).json({ 
        success: false, 
        error: 'No se encontraron mensajes con ese media_id' 
      });
    }

    let updatedCount = 0;
    const batch = db.batch();

    querySnapshot.forEach((docSnapshot) => {
      const messageData = docSnapshot.data();
      
      // Solo actualizar si el mensaje tiene un webhook_link disponible
      if (messageData.webhook_link) {
        batch.update(docSnapshot.ref, {
          media_url: messageData.webhook_link,
          media_status: 'DOWNLOAD_FAILED_EXPIRED',
          updated_at: admin.firestore.FieldValue.serverTimestamp()
        });
        updatedCount++;
      }
    });

    if (updatedCount > 0) {
      await batch.commit();
    }

    res.status(200).json({
      success: true,
      message: `Se actualizaron ${updatedCount} mensajes con media_id expirado`,
      updated_count: updatedCount
    });

  } catch (error) {
    console.error('💥 [handleExpiredMedia] Error general:', error);
    res.status(500).json({
      error: 'Error procesando media expirada',
      details: error.message
    });
  }
}