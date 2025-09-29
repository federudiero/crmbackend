// api/waWebhook.js — bandeja global con soporte de imágenes, audios y stickers (con fallbacks)
import { db, FieldValue, bucket } from "../lib/firebaseAdmin.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function safeParseBody(req) {
  try { return typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}"); }
  catch { return {}; }
}

const digits = (s) => String(s || "").replace(/\D/g, "");
function normalizeE164AR(waIdOrPhone) {
  const d = digits(waIdOrPhone);
  if (d.startsWith("549")) return `+${d}`;
  const m = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m) { const [, area, local] = m; return `+549${area}${local}`; }
  if (d.startsWith("54")) return `+${d}`;
  return `+${d}`;
}
function extractTextFromMessage(m) {
  return (
    m.text?.body ||
    m.interactive?.nfm_reply?.body ||
    m.interactive?.button_reply?.title ||
    m.button?.text ||
    m.image?.caption ||
    m.document?.caption ||
    ""
  );
}

// === Helpers para media ===
const GRAPH = "https://graph.facebook.com/v23.0";
const WA_TOKEN = process.env.META_WA_TOKEN;

/** Descarga metadata + binario del media de WhatsApp */
async function fetchMedia(mediaId) {
  console.log(`🔍 [fetchMedia] Iniciando descarga para mediaId: ${mediaId}`);
  
  try {
    // Paso 1: Obtener metadata
    console.log(`📡 [fetchMedia] Solicitando metadata de ${GRAPH}/${mediaId}`);
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    
    console.log(`📊 [fetchMedia] Respuesta metadata - Status: ${metaRes.status}, OK: ${metaRes.ok}`);
    
    if (!metaRes.ok) {
      console.error(`❌ [fetchMedia] Error en metadata - Status: ${metaRes.status}`);
      const errorText = await metaRes.text();
      console.error(`❌ [fetchMedia] Error details: ${errorText}`);
      return null;
    }
    
    const meta = await metaRes.json();
    console.log(`📋 [fetchMedia] Metadata recibida:`, JSON.stringify(meta, null, 2));
    
    if (!meta?.url) {
      console.error(`❌ [fetchMedia] No se encontró URL en metadata`);
      return null;
    }

    // Paso 2: Descargar binario
    console.log(`📥 [fetchMedia] Descargando binario desde: ${meta.url}`);
    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    
    console.log(`📊 [fetchMedia] Respuesta binario - Status: ${binRes.status}, OK: ${binRes.ok}`);
    
    if (!binRes.ok) {
      console.error(`❌ [fetchMedia] Error descargando binario - Status: ${binRes.status}`);
      const errorText = await binRes.text();
      console.error(`❌ [fetchMedia] Binary error details: ${errorText}`);
      return null;
    }
    
    const arrayBuf = await binRes.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const mime = meta.mime_type || "application/octet-stream";
    
    console.log(`✅ [fetchMedia] Descarga exitosa - Size: ${buf.length} bytes, MIME: ${mime}`);
    return { buf, mime };
    
  } catch (error) {
    console.error(`💥 [fetchMedia] Error inesperado:`, error);
    console.error(`💥 [fetchMedia] Stack trace:`, error.stack);
    return null;
  }
}

/** Guarda el binario en Storage y devuelve URL firmada larga */
async function saveToStorageAndSign(convId, waMessageId, mime, buf) {
  const ext = (mime.split("/")[1] || "bin").split(";")[0];
  const path = `public/conversations/${convId}/${waMessageId}.${ext}`;
  await bucket.file(path).save(buf, { contentType: mime });
  const [url] = await bucket
    .file(path)
    .getSignedUrl({ action: "read", expires: "3025-01-01" });
  return { path, url };
}

export default async function handler(req, res) {
  cors(res);

  // GET de verificación (Meta)
  if (req.method === "GET") {
    const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = safeParseBody(req);
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const meta = value.metadata || {};
    const phoneId = meta.phone_number_id || null;
    const phoneDisplay = meta.display_phone_number || null;

    // ====== MENSAJES ENTRANTES ======
    for (const m of (value.messages || [])) {
      const convId = normalizeE164AR(m.from);
      const waMessageId = m.id;
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text  = extractTextFromMessage(m);

      // contacts
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: convId,
        waId: digits(convId).slice(1),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // conversations
      const convRef = db.collection("conversations").doc(convId);
      const convSnap = await convRef.get();
      const baseConv = {
        contactId: convId,
        lastMessageAt: FieldValue.serverTimestamp(),
        lastInboundPhoneId: phoneId || null,
        lastInboundDisplay: phoneDisplay || null,
      };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      const messageData = {
        direction: "in",
        type: m.type || "text",
        text,
        timestamp: new Date(tsSec * 1000),
        businessPhoneId: phoneId || null,
        businessDisplay: phoneDisplay || null,
        raw: m,
      };

      // === IMAGEN (con fallbacks) ===
      if (m.type === "image") {
        const imgId = m.image?.id || null;
        const imgLink = m.image?.link || null; // Meta a veces envía link temporal

        console.log("🖼️ DEBUG Webhook Image:", {
          waMessageId, convId, hasId: !!imgId, hasLink: !!imgLink
        });

        let saved = null;
        if (imgId) {
          try {
            const file = await fetchMedia(imgId);
            console.log("🖼️ DEBUG Fetched image:", {
              ok: !!file, mime: file?.mime, size: file?.buf?.length
            });
            if (file) {
              saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
              console.log("🖼️ DEBUG Saved image:", saved);
            }
          } catch (error) {
            console.error("🖼️ ERROR downloading/saving image:", error);
            // Si falla la descarga, intentamos usar el link directo si existe
            if (imgLink) {
              console.log("🖼️ FALLBACK: Using direct link from webhook");
            }
          }
        }

        // Fallbacks: si no se pudo guardar, usamos el link que venga del webhook
        if (saved?.url || imgLink) {
          messageData.media = {
            kind: "image",
            path: saved?.path || null,
            url: saved?.url || imgLink || null,
            mime: saved ? undefined : (m.image?.mime_type || undefined),
          };
          messageData.mediaUrl = saved?.url || imgLink; // AGREGADO: URL directa para compatibilidad
        } else {
          // Último recurso: marcamos que hubo imagen aunque no tengamos URL
          console.warn("🖼️ WARNING: Image message without valid URL", { waMessageId, imgId: !!imgId, imgLink: !!imgLink });
          messageData.media = { kind: "image" };
          messageData.hasMedia = true; // Marcamos que tenía media pero no pudimos obtener URL
          messageData.mediaError = "URL_NOT_AVAILABLE"; // Flag para el frontend
        }
      }

      // === AUDIO / VOICE NOTE (con fallback link) ===
      if (m.type === "audio") {
        const audId = m.audio?.id || null;
        const audLink = m.audio?.link || null;
        let saved = null;
        if (audId) {
          try {
            const file = await fetchMedia(audId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (error) {
            console.error("audio error:", error);
          }
        }
        if (saved?.url || audLink) {
          messageData.media = {
            kind: "audio",
            voice: Boolean(m.audio?.voice),
            path: saved?.path || null,
            url: saved?.url || audLink || null,
          };
        } else if (m.type === "audio") {
          messageData.media = { kind: "audio" };
        }
      }

      // === STICKER ===
      if (m.type === "sticker") {
        const stkId = m.sticker?.id || null;
        let saved = null;
        if (stkId) {
          try {
            const file = await fetchMedia(stkId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (error) {
            console.error("sticker error:", error);
          }
        }
        if (saved?.url) {
          messageData.media = {
            kind: "sticker",
            path: saved.path,
            url: saved.url,
          };
        } else {
          messageData.media = { kind: "sticker" }; // al menos marcar el tipo
        }
      }

      await convRef.collection("messages").doc(waMessageId).set(messageData, { merge: true });
      console.log("🖼️ DEBUG Message saved:", {
        waMessageId,
        type: messageData.type,
        hasMedia: !!messageData.media,
        mediaKind: messageData.media?.kind,
        mediaUrl: messageData.media?.url
      });
    }

    // ====== ESTADOS ======
    for (const s of (value.statuses || [])) {
      const convId = normalizeE164AR(s.recipient_id);
      await db
        .collection("conversations")
        .doc(convId)
        .collection("messages")
        .doc(s.id)
        .set(
          { status: s.status, statusTimestamp: new Date(), rawStatus: s },
          { merge: true }
        );
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
