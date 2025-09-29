// api/testImageProcessing.js — Test endpoint para verificar procesamiento de imágenes
import { db, bucket } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  cors(res);
  
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  try {
    const results = {
      timestamp: new Date().toISOString(),
      status: "TESTING",
      tests: {}
    };

    // 1. Test Firebase Storage Bucket
    console.log("🧪 Testing Firebase Storage Bucket...");
    try {
      const [exists] = await bucket.exists();
      results.tests.storage_bucket = {
        status: exists ? "OK" : "ERROR",
        exists,
        name: bucket.name,
        message: exists ? "Bucket exists and accessible" : "Bucket not found"
      };
    } catch (error) {
      results.tests.storage_bucket = {
        status: "ERROR",
        error: error.message,
        message: "Failed to check bucket existence"
      };
    }

    // 2. Test crear archivo de prueba
    console.log("🧪 Testing file upload to Storage...");
    try {
      const testPath = "test/image-test.txt";
      const testContent = `Test file created at ${new Date().toISOString()}`;
      
      await bucket.file(testPath).save(testContent, {
        contentType: "text/plain"
      });

      // Generar URL firmada
      const [url] = await bucket
        .file(testPath)
        .getSignedUrl({ action: "read", expires: "3025-01-01" });

      results.tests.file_upload = {
        status: "OK",
        path: testPath,
        url,
        message: "File uploaded and signed URL generated successfully"
      };

      // Limpiar archivo de prueba
      await bucket.file(testPath).delete();
      
    } catch (error) {
      results.tests.file_upload = {
        status: "ERROR",
        error: error.message,
        message: "Failed to upload test file"
      };
    }

    // 3. Test buscar mensajes con imágenes existentes
    console.log("🧪 Testing existing image messages...");
    try {
      const conversationsSnapshot = await db.collection("conversations").limit(5).get();
      let imageMessages = [];
      
      for (const convDoc of conversationsSnapshot.docs) {
        const messagesSnapshot = await convDoc.ref
          .collection("messages")
          .where("type", "==", "image")
          .limit(3)
          .get();
        
        messagesSnapshot.docs.forEach(msgDoc => {
          const data = msgDoc.data();
          imageMessages.push({
            conversationId: convDoc.id,
            messageId: msgDoc.id,
            hasMedia: !!data.media,
            mediaKind: data.media?.kind,
            hasUrl: !!data.media?.url,
            hasPath: !!data.media?.path,
            timestamp: data.timestamp?.toDate?.()?.toISOString() || data.timestamp
          });
        });
      }

      results.tests.existing_images = {
        status: "OK",
        count: imageMessages.length,
        messages: imageMessages,
        message: `Found ${imageMessages.length} image messages`
      };
      
    } catch (error) {
      results.tests.existing_images = {
        status: "ERROR",
        error: error.message,
        message: "Failed to query existing image messages"
      };
    }

    // 4. Test variables de entorno relacionadas con media
    console.log("🧪 Testing media-related environment variables...");
    const mediaEnvVars = {
      META_WA_TOKEN: !!process.env.META_WA_TOKEN,
      FB_STORAGE_BUCKET: !!process.env.FB_STORAGE_BUCKET,
      FB_PROJECT_ID: !!process.env.FB_PROJECT_ID,
      FB_CLIENT_EMAIL: !!process.env.FB_CLIENT_EMAIL,
      FB_PRIVATE_KEY: !!process.env.FB_PRIVATE_KEY
    };

    results.tests.environment_vars = {
      status: Object.values(mediaEnvVars).every(Boolean) ? "OK" : "WARNING",
      variables: mediaEnvVars,
      message: Object.values(mediaEnvVars).every(Boolean) 
        ? "All media-related environment variables are present"
        : "Some media-related environment variables are missing"
    };

    // Determinar status general
    const allTests = Object.values(results.tests);
    const hasErrors = allTests.some(test => test.status === "ERROR");
    const hasWarnings = allTests.some(test => test.status === "WARNING");
    
    results.status = hasErrors ? "ERROR" : hasWarnings ? "WARNING" : "HEALTHY";
    results.summary = {
      total_tests: allTests.length,
      passed: allTests.filter(test => test.status === "OK").length,
      warnings: allTests.filter(test => test.status === "WARNING").length,
      errors: allTests.filter(test => test.status === "ERROR").length
    };

    console.log("🧪 Image processing test completed:", results.status);
    return res.status(200).json(results);

  } catch (error) {
    console.error("🧪 Image processing test failed:", error);
    return res.status(500).json({
      timestamp: new Date().toISOString(),
      status: "CRITICAL_ERROR",
      error: error.message,
      message: "Image processing test failed completely"
    });
  }
}