export default async function handler(req, res) {
  console.log('🧪 Simulando webhook real de WhatsApp con imagen...');
  
  // Simular payload real de WhatsApp con imagen
  const realWhatsAppPayload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "768483333020913",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "+54 9 351 319-9259",
            phone_number_id: "768483333020913"
          },
          messages: [{
            from: "5493513199259",
            id: `wamid.test_${Date.now()}`,
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: "image",
            image: {
              id: "1234567890_FAKE_MEDIA_ID", // ID falso para testing
              mime_type: "image/jpeg",
              sha256: "fake_sha256_hash_for_testing",
              // Nota: No incluimos 'link' para simular caso real donde solo viene ID
            }
          }]
        },
        field: "messages"
      }]
    }]
  };

  try {
    console.log('📤 Enviando payload simulado al webhook...');
    
    // Llamar al webhook real
    const webhookResponse = await fetch('http://localhost:3000/api/waWebhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(realWhatsAppPayload)
    });

    const webhookResult = await webhookResponse.text();
    
    console.log('📥 Respuesta del webhook:', {
      status: webhookResponse.status,
      ok: webhookResponse.ok,
      result: webhookResult
    });

    res.status(200).json({
      success: true,
      message: 'Webhook simulado ejecutado',
      payload: realWhatsAppPayload,
      webhookResponse: {
        status: webhookResponse.status,
        ok: webhookResponse.ok,
        result: webhookResult
      },
      instructions: [
        '1. Revisa los logs del servidor backend para ver el proceso detallado',
        '2. Busca los logs que empiecen con 🔍 [fetchMedia]',
        '3. Verifica si hay errores en la descarga de metadata o binario',
        '4. Comprueba el mensaje guardado en Firestore'
      ]
    });

  } catch (error) {
    console.error('❌ Error simulando webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
}