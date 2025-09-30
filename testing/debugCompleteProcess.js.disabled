import { db } from '../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  console.log('🔍 Iniciando diagnóstico completo del proceso de imágenes...');
  
  try {
    const diagnostics = {
      timestamp: new Date().toISOString(),
      environment: {},
      whatsappConfig: {},
      firebaseConfig: {},
      messageAnalysis: {},
      webhookTest: {},
      recommendations: []
    };

    // 1. Verificar variables de entorno críticas
    console.log('📋 Verificando configuración de entorno...');
    diagnostics.environment = {
      META_WA_TOKEN: process.env.META_WA_TOKEN ? '✅ Configurado' : '❌ Faltante',
      META_WA_PHONE_ID: process.env.META_WA_PHONE_ID ? '✅ Configurado' : '❌ Faltante',
      META_WA_VERIFY_TOKEN: process.env.META_WA_VERIFY_TOKEN ? '✅ Configurado' : '❌ Faltante',
      FB_PROJECT_ID: process.env.FB_PROJECT_ID ? '✅ Configurado' : '❌ Faltante',
      FB_STORAGE_BUCKET: process.env.FB_STORAGE_BUCKET ? '✅ Configurado' : '❌ Faltante',
      NODE_ENV: process.env.NODE_ENV || 'development'
    };

    // 2. Verificar configuración de WhatsApp
    console.log('📱 Verificando configuración de WhatsApp...');
    const waToken = process.env.META_WA_TOKEN;
    const waPhoneId = process.env.META_WA_PHONE_ID;
    
    if (waToken && waPhoneId) {
      try {
        // Probar conectividad con WhatsApp API
        const testResponse = await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}`, {
          headers: {
            'Authorization': `Bearer ${waToken}`
          }
        });
        
        diagnostics.whatsappConfig = {
          apiConnectivity: testResponse.ok ? '✅ Conectado' : '❌ Error de conexión',
          statusCode: testResponse.status,
          phoneIdValid: waPhoneId ? '✅ Válido' : '❌ Inválido'
        };
        
        if (testResponse.ok) {
          const phoneData = await testResponse.json();
          diagnostics.whatsappConfig.phoneInfo = phoneData;
        }
      } catch (error) {
        diagnostics.whatsappConfig = {
          apiConnectivity: '❌ Error de red',
          error: error.message
        };
      }
    } else {
      diagnostics.whatsappConfig = {
        status: '❌ Configuración incompleta',
        missing: !waToken ? 'META_WA_TOKEN' : 'META_WA_PHONE_ID'
      };
    }

    // 3. Verificar Firebase
    console.log('🔥 Verificando configuración de Firebase...');
    try {
      // Probar conexión a Firestore
      const testDoc = await db.collection('conversations').limit(1).get();
      diagnostics.firebaseConfig.firestoreConnection = '✅ Conectado';
      diagnostics.firebaseConfig.conversationsCount = testDoc.size;
      
      // Probar Firebase Storage
      const { getStorage } = await import('firebase-admin/storage');
      const bucket = getStorage().bucket();
      diagnostics.firebaseConfig.storageConnection = '✅ Conectado';
      diagnostics.firebaseConfig.bucketName = bucket.name;
      
    } catch (error) {
      diagnostics.firebaseConfig = {
        status: '❌ Error de conexión',
        error: error.message
      };
    }

    // 4. Analizar mensajes existentes
    console.log('💬 Analizando mensajes de imagen existentes...');
    try {
      const conversationsSnapshot = await db.collection('conversations').get();
      let totalMessages = 0;
      let imageMessages = 0;
      let messagesWithUrl = 0;
      let messagesWithError = 0;
      let realWhatsAppImages = 0;
      let testImages = 0;

      for (const conversationDoc of conversationsSnapshot.docs) {
        const messagesSnapshot = await db
          .collection('conversations')
          .doc(conversationDoc.id)
          .collection('messages')
          .where('type', '==', 'image')
          .get();

        totalMessages += messagesSnapshot.size;
        
        messagesSnapshot.forEach(messageDoc => {
          const message = messageDoc.data();
          imageMessages++;
          
          // Verificar si tiene URL válida
          const hasValidUrl = message.mediaUrl || 
                             message.media?.url || 
                             message.image?.url;
          
          if (hasValidUrl) messagesWithUrl++;
          if (message.mediaError) messagesWithError++;
          
          // Clasificar tipo de mensaje
          if (message.from?.includes('test') || message.mediaUrl?.includes('picsum')) {
            testImages++;
          } else {
            realWhatsAppImages++;
          }
        });
      }

      diagnostics.messageAnalysis = {
        totalImageMessages: imageMessages,
        messagesWithValidUrl: messagesWithUrl,
        messagesWithError: messagesWithError,
        realWhatsAppImages: realWhatsAppImages,
        testImages: testImages,
        successRate: imageMessages > 0 ? `${((messagesWithUrl / imageMessages) * 100).toFixed(1)}%` : '0%'
      };

    } catch (error) {
      diagnostics.messageAnalysis = {
        status: '❌ Error al analizar mensajes',
        error: error.message
      };
    }

    // 5. Probar proceso de descarga de media
    console.log('📥 Probando proceso de descarga de media...');
    if (waToken) {
      try {
        // Simular descarga de media con un ID de prueba
        const testMediaId = 'test_media_id_123';
        const mediaResponse = await fetch(`https://graph.facebook.com/v21.0/${testMediaId}`, {
          headers: {
            'Authorization': `Bearer ${waToken}`
          }
        });

        diagnostics.webhookTest = {
          mediaApiTest: mediaResponse.status === 404 ? '✅ API responde (404 esperado)' : `Status: ${mediaResponse.status}`,
          tokenValid: mediaResponse.status !== 401 ? '✅ Token válido' : '❌ Token inválido'
        };
      } catch (error) {
        diagnostics.webhookTest = {
          mediaApiTest: '❌ Error de conexión',
          error: error.message
        };
      }
    }

    // 6. Generar recomendaciones
    console.log('💡 Generando recomendaciones...');
    
    if (diagnostics.environment.META_WA_TOKEN === '❌ Faltante') {
      diagnostics.recommendations.push('🔑 Configurar META_WA_TOKEN en variables de entorno');
    }
    
    if (diagnostics.whatsappConfig.apiConnectivity === '❌ Error de conexión') {
      diagnostics.recommendations.push('📱 Verificar conectividad con WhatsApp Business API');
    }
    
    if (diagnostics.messageAnalysis.successRate === '0%') {
      diagnostics.recommendations.push('🖼️ Ninguna imagen se está procesando correctamente - revisar webhook');
    }
    
    if (diagnostics.messageAnalysis.realWhatsAppImages > 0 && diagnostics.messageAnalysis.messagesWithValidUrl === 0) {
      diagnostics.recommendations.push('⚠️ Las imágenes reales de WhatsApp no tienen URLs válidas - problema en fetchMedia');
    }

    console.log('✅ Diagnóstico completo finalizado');
    
    res.status(200).json({
      success: true,
      diagnostics,
      summary: {
        overallStatus: diagnostics.recommendations.length === 0 ? '✅ Sistema funcionando' : '⚠️ Problemas detectados',
        criticalIssues: diagnostics.recommendations.length,
        nextSteps: diagnostics.recommendations.slice(0, 3)
      }
    });

  } catch (error) {
    console.error('❌ Error en diagnóstico:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
}