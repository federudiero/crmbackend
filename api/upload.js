// backend/api/upload.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import Busboy from "busboy";

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // o tu dominio exacto
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const send = (res, status, body = {}) =>
  res.writeHead(status, corsHeaders).end(JSON.stringify(body));

// --- ENV / BUCKET ---
const BUCKET = (process.env.FIREBASE_STORAGE_BUCKET || "").trim(); // 👈 evita espacios
if (!BUCKET) {
  console.error("FIREBASE_STORAGE_BUCKET missing");
}

// --- Admin init ---
let initErr = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  const SA = JSON.parse(raw);

  if (!getApps().length) {
    // No seteamos el bucket acá; lo forzamos más abajo con getStorage().bucket(BUCKET)
    initializeApp({ credential: cert(SA) });
  }
} catch (e) {
  initErr = e;
  console.error("Admin init error:", e);
}

// --- multipart parser ---
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

    bb.on("finish", () => resolve({
      conversationId,
      filename,
      mime,
      buffer: Buffer.concat(chunks),
    }));

    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "POST") return send(res, 405, { ok:false, error:"Method not allowed" });

  if (initErr) return send(res, 500, { ok:false, error:`Admin init: ${initErr.message}` });

  try {
    const bucket = getStorage().bucket(BUCKET);        // 👈 forzamos bucket de la env
    if (!bucket?.name) throw new Error("Bucket not available");
    if (bucket.name !== BUCKET) {
      throw new Error(`Bucket mismatch: got ${bucket.name}, expected ${BUCKET}`);
    }

    const { conversationId, filename, mime, buffer } = await readMultipartFile(req);
    if (!conversationId) return send(res, 400, { ok:false, error:"conversationId faltante" });
    if (!buffer?.length) return send(res, 400, { ok:false, error:"archivo faltante" });

    // Validaciones estilo WhatsApp
    if (!/^(image|audio)\//.test(mime)) return send(res, 415, { ok:false, error:"Tipo no permitido" });
    if (buffer.length > 25 * 1024 * 1024) return send(res, 413, { ok:false, error:"Archivo > 25MB" });

    const safeName = (filename || "file").replace(/[^\w.\-]+/g, "_");
    const objectPath = `uploads/${conversationId}/${Date.now()}_${safeName}`;

    await bucket.file(objectPath).save(buffer, {
      contentType: mime,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media`;

    return send(res, 200, { ok:true, url, path: objectPath, contentType: mime, size: buffer.length });
  } catch (err) {
    console.error("upload error:", err);
    return send(res, 500, { ok:false, error: err.message || "Upload failed" });
  }
}

export const config = { api: { bodyParser: false } };
