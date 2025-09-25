// api/upload.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import Busboy from "busboy";

// --- Admin init ---
const SA = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

if (!getApps().length) {
  initializeApp(
    SA
      ? { credential: cert(SA), storageBucket: process.env.FIREBASE_STORAGE_BUCKET }
      : { storageBucket: process.env.FIREBASE_STORAGE_BUCKET }
  );
}
const bucket = getStorage().bucket();

// --- CORS headers ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",                 // o tu dominio exacto
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Parsear multipart
function readMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let conversationId = "";
    let filename = "";
    let mime = "";
    const chunks = [];

    bb.on("field", (name, val) => {
      if (name === "conversationId") conversationId = String(val || "").trim();
    });

    bb.on("file", (_name, file, info) => {
      filename = info?.filename || "upload.bin";
      mime = info?.mimeType || "application/octet-stream";
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => reject(new Error("Archivo demasiado grande")));
    });

    bb.on("finish", () =>
      resolve({ conversationId, filename, mime, buffer: Buffer.concat(chunks) })
    );

    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders).end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  try {
    const { conversationId, filename, mime, buffer } = await readMultipartFile(req);
    if (!conversationId) {
      res.writeHead(400, corsHeaders).end(JSON.stringify({ ok:false, error:"conversationId faltante" }));
      return;
    }
    if (!buffer?.length) {
      res.writeHead(400, corsHeaders).end(JSON.stringify({ ok:false, error:"archivo faltante" }));
      return;
    }

    // Validaciones
    const allowed = /^(image|audio)\//.test(mime);
    const maxBytes = 25 * 1024 * 1024;
    if (!allowed) {
      res.writeHead(415, corsHeaders).end(JSON.stringify({ ok:false, error:"Tipo no permitido" }));
      return;
    }
    if (buffer.length > maxBytes) {
      res.writeHead(413, corsHeaders).end(JSON.stringify({ ok:false, error:"Archivo > 25MB" }));
      return;
    }

    // Guardar
    const safeName = (filename || "file").replace(/[^\w.\-]+/g, "_");
    const objectPath = `uploads/${conversationId}/${Date.now()}_${safeName}`;
    const file = bucket.file(objectPath);
    await file.save(buffer, {
      contentType: mime,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    // URL pública (si Storage tiene read público)
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media`;

    res.writeHead(200, corsHeaders).end(JSON.stringify({
      ok: true, url, path: objectPath, contentType: mime, size: buffer.length
    }));
  } catch (err) {
    console.error("upload error", err);
    res.writeHead(500, corsHeaders).end(JSON.stringify({ ok:false, error: err.message || "Upload failed" }));
  }
}

export const config = { api: { bodyParser: false } };
