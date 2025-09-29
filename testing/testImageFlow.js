// api/testImageFlow.js
// Endpoint para probar el flujo completo de imágenes

export default async function handler(req, res) {
  console.log('🧪 [testImageFlow] Iniciando prueba del flujo de imágenes');
  
  try {
    // Simular mensaje de WhatsApp con imagen
    const simulatedMessage = {
      object: "whatsapp_business_account",
      entry: [{
        id: "test_entry",
        changes: [{
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550199999",
              phone_number_id: "test_phone_id"
            },
            messages: [{
              from: "5491123456789",
              id: "test_message_" + Date.now(),
              timestamp: Math.floor(Date.now() / 1000).toString(),
              type: "image",
              image: {
                caption: "Imagen de prueba",
                mime_type: "image/jpeg",
                sha256: "test_sha256_hash",
                id: "test_media_id_" + Date.now()
              }
            }]
          },
          field: "messages"
        }]
      }]
    };

    console.log('📤 [testImageFlow] Enviando mensaje simulado al webhook principal');
    
    // Simular el procesamiento del webhook
    const webhookUrl = req.headers.host?.includes('localhost') 
      ? 'http://localhost:3000/api/waWebhook'
      : 'https://crmbackend-chi.vercel.app/api/waWebhook';

    console.log('🎯 [testImageFlow] URL del webhook:', webhookUrl);
    console.log('📋 [testImageFlow] Mensaje simulado:', JSON.stringify(simulatedMessage, null, 2));

    res.status(200).json({
      success: true,
      message: 'Flujo de imagen simulado correctamente',
      data: {
        webhookUrl,
        simulatedMessage,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('💥 [testImageFlow] Error:', error);
    res.status(500).json({
      error: 'Error en la prueba del flujo de imágenes',
      details: error.message
    });
  }
}