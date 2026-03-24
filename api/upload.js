// backend/api/upload.js
import Busboy from "busboy";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { bucket } from "../lib/firebaseAdmin.js";

// ===== CORS =====
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
};

const send = (res, status, body = {}) =>
  res.writeHead(status, corsHeaders).end(JSON.stringify(body));

// ===== Constantes =====
const MB = 1024 * 1024;
const MAX_INPUT_BYTES = 25 * MB; // límite de entrada del backend
const MAX_IMAGE_BYTES = 5 * MB;  // WhatsApp imagen
const MAX_AUDIO_BYTES = 16 * MB; // WhatsApp audio
const MAX_DOC_BYTES = 25 * MB;   // conservamos tu límite actual

function safeBaseName(name = "upload") {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  return (base || "upload").replace(/[^\w.-]+/g, "_");
}

function extForMime(mime = "") {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/amr": "amr",
    "application/pdf": "pdf",
  };
  return map[mime] || "bin";
}

async function cleanupFiles(paths = []) {
  await Promise.all(
    paths.map(async (p) => {
      if (!p) return;
      try {
        await fs.unlink(p);
      } catch {
        // ignore
      }
    })
  );
}

// ===== Multipart =====
function readMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: MAX_INPUT_BYTES,
      },
    });

    let conversationId = "";
    let filename = "";
    let mime = "";
    const chunks = [];
    let gotFile = false;
    let rejected = false;

    bb.on("field", (name, val) => {
      if (name === "conversationId") {
        conversationId = String(val || "").trim();
      }
    });

    bb.on("file", (_fieldName, file, info) => {
      gotFile = true;
      filename = info?.filename || "upload.bin";
      mime = String(info?.mimeType || "application/octet-stream").toLowerCase();

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("limit", () => {
        rejected = true;
        reject(new Error("Archivo demasiado grande (>25MB)"));
      });
    });

    bb.on("finish", () => {
      if (rejected) return;
      if (!gotFile) return reject(new Error("archivo faltante"));

      resolve({
        conversationId,
        filename,
        mime,
        buffer: Buffer.concat(chunks),
      });
    });

    bb.on("error", reject);
    req.pipe(bb);
  });
}

// ===== Audio conversion =====
async function transcodeToOggOpus(inputBuffer, inputExt = "bin") {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static no está disponible. Instalá la dependencia y redeployá el backend."
    );
  }

  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}.${inputExt || "bin"}`);
  const outPath = path.join(os.tmpdir(), `${id}.ogg`);

  try {
    await fs.writeFile(inPath, inputBuffer);

    await new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i",
        inPath,
        "-vn",
        "-ac",
        "1",         // mono
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-f",
        "ogg",
        outPath,
      ];

      const proc = spawn(ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";

      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("error", (err) => {
        reject(err);
      });

      proc.on("close", (code) => {
        if (code === 0) return resolve();
        reject(
          new Error(
            stderr?.trim() || `ffmpeg terminó con código ${code}`
          )
        );
      });
    });

    return await fs.readFile(outPath);
  } finally {
    await cleanupFiles([inPath, outPath]);
  }
}

// ===== Normalización =====
async function normalizeUpload({ buffer, filename, clientMime }) {
  const sniffed = await fileTypeFromBuffer(buffer).catch(() => null);

  const sniffMime = String(sniffed?.mime || "").toLowerCase();
  const sniffExt = String(sniffed?.ext || "").toLowerCase();
  const declaredMime = String(clientMime || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const originalExt = path.extname(filename || "").replace(".", "").toLowerCase();

  const isPdf =
    sniffMime === "application/pdf" ||
    declaredMime === "application/pdf" ||
    originalExt === "pdf";

  const isImage =
    sniffMime.startsWith("image/") ||
    declaredMime.startsWith("image/");

  const isAudio =
    declaredMime.startsWith("audio/") ||
    sniffMime.startsWith("audio/") ||
    (originalExt === "webm" && declaredMime === "audio/webm") ||
    (sniffMime === "video/webm" && declaredMime === "audio/webm");

  if (!isPdf && !isImage && !isAudio) {
    throw new Error(
      `Tipo no permitido. declared=${declaredMime || "?"} sniffed=${sniffMime || "?"}`
    );
  }

  // ---------- PDF ----------
  if (isPdf) {
    if (buffer.length > MAX_DOC_BYTES) {
      throw new Error("PDF > 25MB");
    }

    return {
      buffer,
      contentType: "application/pdf",
      ext: "pdf",
      converted: false,
      originalContentType: declaredMime || sniffMime || "application/pdf",
      detectedContentType: sniffMime || declaredMime || "application/pdf",
    };
  }

  // ---------- Imagen ----------
  if (isImage) {
    const effectiveImageMime =
      sniffMime && sniffMime.startsWith("image/")
        ? sniffMime
        : declaredMime;

    // WhatsApp imagen normal: jpeg/png
    if (effectiveImageMime === "image/jpeg" || effectiveImageMime === "image/png") {
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error("La imagen supera 5MB, WhatsApp la va a rechazar");
      }

      return {
        buffer,
        contentType: effectiveImageMime,
        ext: extForMime(effectiveImageMime),
        converted: false,
        originalContentType: declaredMime || effectiveImageMime,
        detectedContentType: sniffMime || effectiveImageMime,
      };
    }

    // webp/heic/gif/etc => jpeg
    const jpgBuffer = await sharp(buffer, { animated: false })
      .rotate()
      .jpeg({
        quality: 88,
        mozjpeg: true,
      })
      .toBuffer();

    if (jpgBuffer.length > MAX_IMAGE_BYTES) {
      throw new Error("La imagen convertida supera 5MB, WhatsApp la va a rechazar");
    }

    return {
      buffer: jpgBuffer,
      contentType: "image/jpeg",
      ext: "jpg",
      converted: true,
      originalContentType: declaredMime || effectiveImageMime || "application/octet-stream",
      detectedContentType: sniffMime || declaredMime || "application/octet-stream",
    };
  }

  // ---------- Audio ----------
  // Dejamos pasar MP3 / M4A.
  // Todo lo demás lo normalizamos a OGG/OPUS mono para Meta.
  const sourceAudioMime =
    declaredMime === "audio/webm"
      ? "audio/webm"
      : sniffMime === "video/webm" && declaredMime === "audio/webm"
      ? "audio/webm"
      : sniffMime || declaredMime || "application/octet-stream";

  const passthroughAudio = new Set(["audio/mpeg", "audio/mp4"]);

  if (passthroughAudio.has(sourceAudioMime)) {
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new Error("El audio supera 16MB, WhatsApp lo va a rechazar");
    }

    return {
      buffer,
      contentType: sourceAudioMime,
      ext: extForMime(sourceAudioMime),
      converted: false,
      originalContentType: declaredMime || sourceAudioMime,
      detectedContentType: sniffMime || sourceAudioMime,
    };
  }

  const inputExt = originalExt || sniffExt || "bin";
  const oggBuffer = await transcodeToOggOpus(buffer, inputExt);

  if (oggBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error("El audio convertido supera 16MB, WhatsApp lo va a rechazar");
  }

  return {
    buffer: oggBuffer,
    contentType: "audio/ogg",
    ext: "ogg",
    converted: true,
    originalContentType: declaredMime || sourceAudioMime,
    detectedContentType: sniffMime || declaredMime || sourceAudioMime,
  };
}

// ===== Handler =====
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") {
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    if (!bucket?.name) {
      throw new Error("Bucket not available");
    }

    const { conversationId, filename, mime, buffer } = await readMultipartFile(req);

    if (!conversationId) {
      return send(res, 400, { ok: false, error: "conversationId faltante" });
    }

    if (!buffer?.length) {
      return send(res, 400, { ok: false, error: "archivo faltante" });
    }

    const normalized = await normalizeUpload({
      buffer,
      filename,
      clientMime: mime,
    });

    const baseName = safeBaseName(filename || "upload");
    const finalName = `${Date.now()}_${baseName}.${normalized.ext}`;
    const objectPath = `public/conversations/${conversationId}/${finalName}`;

    const file = bucket.file(objectPath);

    await file.save(normalized.buffer, {
      resumable: false,
      contentType: normalized.contentType,
      metadata: {
        contentType: normalized.contentType,
        cacheControl: "public, max-age=31536000",
        metadata: {
          originalFilename: filename || "upload",
          originalContentType: normalized.originalContentType || "",
          detectedContentType: normalized.detectedContentType || "",
          converted: normalized.converted ? "1" : "0",
        },
      },
    });

    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: "3025-01-01",
    });

    return send(res, 200, {
      ok: true,
      url: signedUrl,
      path: objectPath,
      contentType: normalized.contentType,
      originalContentType: normalized.originalContentType,
      detectedContentType: normalized.detectedContentType,
      converted: normalized.converted,
      size: normalized.buffer.length,
      gcsUrl: `https://storage.googleapis.com/${bucket.name}/${objectPath}`,
    });
  } catch (err) {
    console.error("upload error:", err);
    return send(res, 500, {
      ok: false,
      error: err?.message || "Upload failed",
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};