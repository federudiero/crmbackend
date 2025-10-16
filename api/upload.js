// backend/api/upload.js
import { bucket } from "../lib/firebaseAdmin.js";
import Busboy from "busboy";

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // o tu dominio exacto en prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const send = (res, status, body = {}) =>
  res.writeHead(status, corsHeaders).end(JSON.stringify(body));

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

    bb.on("finish", () =>
      resolve({
        conversationId,
        filename,
        mime,
        buffer: Buffer.concat(chunks),
      })
    );

    bb.on("error", reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "POST")
    return send(res, 405, { ok: false, error: "Method not allowed" });

  try {
    if (!bucket?.name) throw new Error("Bucket not available");

    const { conversationId, filename, mime, buffer } =
      await readMultipartFile(req);
    if (!conversationId)
      return send(res, 400, { ok: false, error: "conversationId faltante" });
    if (!buffer?.length)
      return send(res, 400, { ok: false, error: "archivo faltante" });

    // Validaciones estilo WhatsApp (+ PDF documentos)
    if (!/^(image|audio)\//.test(mime) && mime !== "application/pdf")
      return send(res, 415, { ok: false, error: "Tipo no permitido" });
    if (buffer.length > 25 * 1024 * 1024)
      return send(res, 413, { ok: false, error: "Archivo > 25MB" });

    const safeName = (filename || "file").replace(/[^\w.\-]+/g, "_");
    const objectPath = `public/conversations/${conversationId}/${Date.now()}_${safeName}`;

    const file = bucket.file(objectPath);
    await file.save(buffer, {
      contentType: mime,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    // 🔑 URL firmada (legible por el navegador) – sin cambiar nada de los entrantes
    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: "3025-01-01",
    });

    // (Opcional) URL pública directa del bucket por si querés testear aparte
    const gcsUrl = `https://storage.googleapis.com/${bucket.name}/${objectPath}`;

    return send(res, 200, {
      ok: true,
      url: signedUrl, // ⬅️ usar SIEMPRE ésta en el front/Graph para salientes
      path: objectPath,
      contentType: mime,
      size: buffer.length,
      gcsUrl,
    });
  } catch (err) {
    console.error("upload error:", err);
    return send(res, 500, { ok: false, error: err.message || "Upload failed" });
  }
}

export const config = { api: { bodyParser: false } };
