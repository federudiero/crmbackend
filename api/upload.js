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
const MAX_INPUT_BYTES = 25 * MB;
const MAX_IMAGE_BYTES = 5 * MB;
const MAX_AUDIO_BYTES = 16 * MB;
const MAX_DOC_BYTES = 25 * MB;
const MIN_AUDIO_BYTES = 1024;

function makeHttpError(message, statusCode = 400, code = "bad_request", details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.details = details;
  return err;
}

function baseMime(mime = "") {
  return String(mime || "").toLowerCase().split(";")[0].trim();
}

function safeBaseStem(name = "upload") {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  return (base || "upload").replace(/[^\w.-]+/g, "_");
}

function extForMime(mime = "") {
  const m = baseMime(mime);
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/aac": "aac",
    "audio/webm": "webm",
    "application/pdf": "pdf",
  };
  return map[m] || "bin";
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
        reject(makeHttpError("Archivo demasiado grande (>25MB)", 413, "file_too_large"));
      });
    });

    bb.on("finish", () => {
      if (rejected) return;
      if (!gotFile) return reject(makeHttpError("archivo faltante", 400, "missing_file"));

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
async function transcodeToMp3(inputBuffer, inputExt = "bin") {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static no está disponible. Instalá la dependencia y redeployá el backend."
    );
  }

  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}.${inputExt || "bin"}`);
  const outPath = path.join(os.tmpdir(), `${id}.mp3`);

  try {
    await fs.writeFile(inPath, inputBuffer);

    await new Promise((resolve, reject) => {
      const args = [
        "-v",
        "error",
        "-y",
        "-i",
        inPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "96k",
        outPath,
      ];

      const proc = spawn(ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";

      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("error", reject);

      proc.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(stderr?.trim() || `ffmpeg terminó con código ${code}`));
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

  const sniffMime = baseMime(sniffed?.mime || "");
  const sniffExt = String(sniffed?.ext || "").toLowerCase();
  const declaredMime = baseMime(clientMime);
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
    sniffMime.startsWith("video/") ||
    ["webm", "ogg", "oga", "wav", "aac", "mp3", "m4a", "amr"].includes(originalExt);

  if (!isPdf && !isImage && !isAudio) {
    throw makeHttpError(
      `Tipo no permitido. declared=${declaredMime || "?"} sniffed=${sniffMime || "?"}`,
      415,
      "unsupported_media_type"
    );
  }

  // ---------- PDF ----------
  if (isPdf) {
    if (buffer.length > MAX_DOC_BYTES) {
      throw makeHttpError("PDF > 25MB", 413, "pdf_too_large");
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

    if (effectiveImageMime === "image/jpeg" || effectiveImageMime === "image/png") {
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw makeHttpError(
          "La imagen supera 5MB, WhatsApp la va a rechazar",
          413,
          "image_too_large"
        );
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

    const jpgBuffer = await sharp(buffer, { animated: false })
      .rotate()
      .jpeg({
        quality: 88,
        mozjpeg: true,
      })
      .toBuffer();

    if (jpgBuffer.length > MAX_IMAGE_BYTES) {
      throw makeHttpError(
        "La imagen convertida supera 5MB, WhatsApp la va a rechazar",
        413,
        "image_too_large_after_conversion"
      );
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
  if (buffer.length < MIN_AUDIO_BYTES) {
    throw makeHttpError(
      "El audio llegó vacío o incompleto. Grabalo de nuevo.",
      422,
      "invalid_audio_input"
    );
  }

  const sourceAudioMime =
    declaredMime === "audio/webm"
      ? "audio/webm"
      : sniffMime === "video/webm" && declaredMime === "audio/webm"
      ? "audio/webm"
      : sniffMime || declaredMime || "application/octet-stream";

  if (sourceAudioMime === "audio/mpeg") {
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw makeHttpError(
        "El audio supera 16MB, WhatsApp lo va a rechazar",
        413,
        "audio_too_large"
      );
    }

    return {
      buffer,
      contentType: "audio/mpeg",
      ext: "mp3",
      converted: false,
      originalContentType: declaredMime || sourceAudioMime,
      detectedContentType: sniffMime || sourceAudioMime,
    };
  }

  const inputExt = originalExt || sniffExt || extForMime(sourceAudioMime) || "bin";

  let mp3Buffer;
  try {
    mp3Buffer = await transcodeToMp3(buffer, inputExt);
  } catch (e) {
    throw makeHttpError(
      "No se pudo procesar el audio grabado. Probá grabarlo de nuevo.",
      422,
      "invalid_audio_input",
      {
        declaredMime,
        detectedMime: sniffMime,
        originalExt,
        ffmpeg: String(e?.message || "").slice(0, 1200),
      }
    );
  }

  if (!mp3Buffer?.length || mp3Buffer.length < MIN_AUDIO_BYTES) {
    throw makeHttpError(
      "El audio convertido quedó vacío o incompleto.",
      422,
      "invalid_audio_output"
    );
  }

  if (mp3Buffer.length > MAX_AUDIO_BYTES) {
    throw makeHttpError(
      "El audio convertido supera 16MB, WhatsApp lo va a rechazar",
      413,
      "audio_too_large_after_conversion"
    );
  }

  return {
    buffer: mp3Buffer,
    contentType: "audio/mpeg",
    ext: "mp3",
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
      throw makeHttpError("Bucket not available", 500, "bucket_unavailable");
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

    const baseStem = safeBaseStem(filename || "upload");
    const finalName = `${Date.now()}_${baseStem}.${normalized.ext}`;
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
    return send(res, Number(err?.statusCode || 500), {
      ok: false,
      error: err?.message || "Upload failed",
      code: err?.code || "upload_failed",
      details: err?.details || null,
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};
