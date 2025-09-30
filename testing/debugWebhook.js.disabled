// Debug endpoint para capturar peticiones del webhook de WhatsApp

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: req.body,
    userAgent: req.headers['user-agent'],
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length']
  };

  // Log en consola
  console.log('=== DEBUG WEBHOOK ===');
  console.log('Timestamp:', timestamp);
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Query:', JSON.stringify(req.query, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('=====================');

  try {
    // Log básico sin Firebase por ahora
    console.log('Petición capturada exitosamente');

    // Si es una petición de WhatsApp, procesarla
    if (req.method === 'POST' && req.body) {
      const { entry } = req.body;
      
      if (entry && entry[0] && entry[0].changes) {
        const changes = entry[0].changes[0];
        const messages = changes.value?.messages || [];
        
        console.log('MENSAJES DETECTADOS:', messages.length);
        
        messages.forEach((message, index) => {
          console.log(`Mensaje ${index + 1}:`, {
            id: message.id,
            type: message.type,
            from: message.from,
            timestamp: message.timestamp,
            hasImage: message.type === 'image',
            imageData: message.image || null
          });
        });
      }
    }

    return res.status(200).json({
      status: 'DEBUG_SUCCESS',
      message: 'Petición capturada y loggeada',
      timestamp,
      method: req.method,
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : []
    });

  } catch (error) {
    console.error('Error en debug webhook:', error);
    return res.status(500).json({
      status: 'DEBUG_ERROR',
      error: error.message,
      timestamp
    });
  }
}