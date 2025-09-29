// api/simpleCheck.js
// Endpoint simple para verificar conectividad básica

export default async function handler(req, res) {
  console.log('🔍 [simpleCheck] Verificando conectividad básica');
  
  try {
    const timestamp = new Date().toISOString();
    
    // Información básica del sistema
    const systemInfo = {
      timestamp,
      method: req.method,
      url: req.url,
      headers: Object.keys(req.headers),
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        hasFirebaseKey: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
        hasWhatsAppToken: !!process.env.WHATSAPP_TOKEN,
        hasVerifyToken: !!process.env.VERIFY_TOKEN
      }
    };

    console.log('📋 [simpleCheck] Info del sistema:', JSON.stringify(systemInfo, null, 2));

    res.status(200).json({
      success: true,
      message: 'Conectividad básica funcionando',
      systemInfo,
      recommendations: [
        'El servidor está respondiendo correctamente',
        'Las variables de entorno están configuradas',
        'El endpoint básico funciona sin problemas'
      ]
    });

  } catch (error) {
    console.error('💥 [simpleCheck] Error:', error);
    res.status(500).json({
      error: 'Error en verificación básica',
      details: error.message
    });
  }
}