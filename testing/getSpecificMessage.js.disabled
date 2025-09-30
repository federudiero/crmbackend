import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messageId } = req.query;
    
    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required' });
    }

    console.log(`🔍 Buscando mensaje: ${messageId}`);

    // Buscar en todas las conversaciones
    const conversationsRef = collection(db, 'conversations');
    const conversationsSnapshot = await getDocs(conversationsRef);
    
    let foundMessage = null;
    let foundConversationId = null;

    for (const conversationDoc of conversationsSnapshot.docs) {
      const conversationId = conversationDoc.id;
      const messagesRef = collection(db, 'conversations', conversationId, 'messages');
      const messageDoc = await getDoc(doc(messagesRef, messageId));
      
      if (messageDoc.exists()) {
        foundMessage = { id: messageDoc.id, ...messageDoc.data() };
        foundConversationId = conversationId;
        break;
      }
    }

    if (!foundMessage) {
      return res.status(404).json({ 
        error: 'Message not found',
        messageId: messageId,
        timestamp: new Date().toISOString()
      });
    }

    console.log(`✅ Mensaje encontrado en conversación: ${foundConversationId}`);

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'SUCCESS',
      conversationId: foundConversationId,
      message: foundMessage,
      debug: {
        hasMedia: foundMessage.hasMedia,
        mediaKind: foundMessage.mediaKind,
        type: foundMessage.type,
        media: foundMessage.media,
        mediaUrl: foundMessage.mediaUrl,
        image: foundMessage.image,
        allKeys: Object.keys(foundMessage)
      }
    });

  } catch (error) {
    console.error('❌ Error al buscar mensaje:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}