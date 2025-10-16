// api/waWebhook.js — webhook WhatsApp con media entrante robusto + replyTo en entrantes + EMAIL AL VENDEDOR
import { db, FieldValue, bucket } from "../lib/firebaseAdmin.js";
import { sendEmail } from "../lib/email.js"; // 👈 NUEVO: helper de email

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

// 🔧 Quita únicamente 'undefined' (Firestore los rechaza)
function stripUndefined(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const vv = stripUndefined(v);
    if (vv !== undefined) out[k] = vv;
  }
  return out;
}

// === Helpers media ===
const GRAPH   = "https://graph.facebook.com/v23.0";
const WA_TOKEN = process.env.META_WA_TOKEN;

/** Descarga metadata + binario del media de WhatsApp (con reintentos rápidos) */
async function fetchMedia(mediaId, retryCount = 0) {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS  = 5000;

  console.log(`🔍 [fetchMedia] Iniciando descarga para mediaId: ${mediaId} (intento ${retryCount + 1}/${MAX_RETRIES + 1})`);
  try {
    // 1) Metadata (timeout)
    const metaController = new AbortController();
    const metaTimeout = setTimeout(() => metaController.abort(), TIMEOUT_MS);
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      signal: metaController.signal
    });
    clearTimeout(metaTimeout);
    console.log(`📊 [fetchMedia] Metadata status=${metaRes.status}`);

    if (!metaRes.ok) {
      const t = await metaRes.text();
      console.error(`❌ [fetchMedia] Metadata error ${metaRes.status}: ${t}`);
      if (metaRes.status === 400 && retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 120));
        return fetchMedia(mediaId, retryCount + 1);
      }
      return null;
    }

    const meta = await metaRes.json();
    console.log(`📋 [fetchMedia] Metadata: ${JSON.stringify(meta)}`);
    if (!meta?.url) return null;

    // 2) Binario (timeout)
    const binController = new AbortController();
    const binTimeout = setTimeout(() => binController.abort(), TIMEOUT_MS);
    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      signal: binController.signal
    });
    clearTimeout(binTimeout);
    console.log(`📊 [fetchMedia] Binario status=${binRes.status}`);

    if (!binRes.ok) {
      const t = await binRes.text();
      console.error(`❌ [fetchMedia] Binario error ${binRes.status}: ${t}`);
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 120));
        return fetchMedia(mediaId, retryCount + 1);
      }
      return null;
    }

    const arr = await binRes.arrayBuffer();
    const buf = Buffer.from(arr);
    const mime = meta.mime_type || "application/octet-stream";
    console.log(`✅ [fetchMedia] OK size=${buf.length} mime=${mime}`);
    return { buf, mime };

  } catch (err) {
    console.error(`💥 [fetchMedia] Error intento ${retryCount + 1}:`, err?.message || err);
    if (retryCount < MAX_RETRIES && (err?.name === "AbortError" || err?.code === "ECONNRESET")) {
      await new Promise(r => setTimeout(r, 200));
      return fetchMedia(mediaId, retryCount + 1);
    }
    return null;
  }
}

/** Sube a Storage y devuelve URL firmada larga */
async function saveToStorageAndSign(convId, waMessageId, mime, buf) {
  const ext  = (mime.split("/")[1] || "bin").split(";")[0];
  const path = `public/conversations/${convId}/${waMessageId}.${ext}`;
  await bucket.file(path).save(buf, { contentType: mime });
  const [url] = await bucket.file(path).getSignedUrl({ action: "read", expires: "3025-01-01" });
  return { path, url };
}

export default async function handler(req, res) {
  cors(res);

  // Verificación de webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.META_WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body  = safeParseBody(req);
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const meta         = value.metadata || {};
    const phoneId      = meta.phone_number_id || null;
    const phoneDisplay = meta.display_phone_number || null;

    // ===== MENSAJES ENTRANTES =====
    for (const m of (value.messages || [])) {
      const convId      = normalizeE164AR(m.from);
      const waMessageId = m.id;
      const tsSec       = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text        = extractTextFromMessage(m);

      // contact
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: convId,
        waId: digits(convId).slice(1),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // conversation
      const convRef = db.collection("conversations").doc(convId);
      const convSnap = await convRef.get();
      const baseConv = {
        contactId: convId,
        lastMessageAt: FieldValue.serverTimestamp(),
        lastInboundPhoneId: phoneId,
        lastInboundDisplay: phoneDisplay,
      };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      // marca inbound “ahora” (además de lastMessageAt)
      await convRef.set(
        {
          lastInboundAt: FieldValue.serverTimestamp(),
          lastMessageText: text || "",
        },
        { merge: true }
      );

      // message base
      const messageData = {
        direction: "in", // tu lógica usa "in" para entrantes
        type: m.type || "text",
        text,
        timestamp: new Date(tsSec * 1000),
        businessPhoneId: phoneId,
        businessDisplay: phoneDisplay,
        raw: m,
      };

      // === IMAGEN ===
      if (m.type === "image") {
        const imgId   = m.image?.id || null;
        const imgLink = m.image?.link || null;

        console.log("🖼️ DEBUG Webhook Image:", { waMessageId, convId, hasId: !!imgId, hasLink: !!imgLink });

        let saved = null;
        if (imgId) {
          try {
            const file = await fetchMedia(imgId);
            console.log("🖼️ DEBUG Fetched image:", { ok: !!file, mime: file?.mime, size: file?.buf?.length });
            if (file) {
              saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
              console.log("🖼️ DEBUG Saved image:", saved);
            }
          } catch (error) {
            console.error("🖼️ ERROR downloading/saving image:", error);
          }
        }

        const media = {
          kind: "image",
          ...(saved?.path ? { path: saved.path } : {}),
          ...((saved?.url || imgLink) ? { url: saved?.url || imgLink } : {}),
          ...(m.image?.mime_type ? { mime: m.image.mime_type } : {}),
        };

        if (!media.url) {
          console.warn("🖼️ WARNING: Image message without valid URL", { waMessageId, imgId: !!imgId, imgLink: !!imgLink });
          messageData.media = { kind: "image" };
          messageData.hasMedia = true;
          messageData.mediaError = "DOWNLOAD_FAILED_EXPIRED";
        } else {
          messageData.media = media;
          messageData.mediaUrl = media.url;
        }
      }

      // === AUDIO ===
      if (m.type === "audio") {
        const audId   = m.audio?.id || null;
        const audLink = m.audio?.link || null;
        let saved = null;
        if (audId) {
          try {
            const file = await fetchMedia(audId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (e) { console.error("audio error:", e); }
        }
        const media = {
          kind: "audio",
          ...(Boolean(m.audio?.voice) ? { voice: true } : {}),
          ...(saved?.path ? { path: saved.path } : {}),
          ...((saved?.url || audLink) ? { url: saved?.url || audLink } : {}),
        };
        messageData.media = Object.keys(media).length ? media : { kind: "audio" };
      }

      // === DOCUMENT ===
      if (m.type === "document") {
        const docId   = m.document?.id || null;
        const docLink = m.document?.link || null;

        console.log("📄 DEBUG Webhook Document:", { waMessageId, convId, hasId: !!docId, hasLink: !!docLink });

        let saved = null;
        if (docId) {
          try {
            const file = await fetchMedia(docId);
            console.log("📄 DEBUG Fetched document:", { ok: !!file, mime: file?.mime, size: file?.buf?.length });
            if (file) {
              saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
              console.log("📄 DEBUG Saved document:", saved);
            }
          } catch (error) {
            console.error("📄 ERROR downloading/saving document:", error);
          }
        }

        const media = {
          kind: "document",
          ...(m.document?.filename ? { filename: m.document.filename } : {}),
          ...(saved?.path ? { path: saved.path } : {}),
          ...((saved?.url || docLink) ? { url: saved?.url || docLink } : {}),
          ...(m.document?.mime_type ? { mime: m.document.mime_type } : {}),
        };

        if (!media.url) {
          console.warn("📄 WARNING: Document message without valid URL", { waMessageId, docId: !!docId, docLink: !!docLink });
          messageData.media = { kind: "document", ...(media.filename ? { filename: media.filename } : {}) };
          messageData.hasMedia = true;
          messageData.mediaError = "DOWNLOAD_FAILED_EXPIRED";
        } else {
          messageData.media = media;
          messageData.mediaUrl = media.url;
        }
      }

      // === LOCATION ===
      if (m.type === "location") {
        const lat = Number(m?.location?.latitude);
        const lng = Number(m?.location?.longitude);
        const name = m?.location?.name || null;
        const address = m?.location?.address || null;
        const gmaps = (Number.isFinite(lat) && Number.isFinite(lng))
          ? `https://www.google.com/maps?q=${lat},${lng}`
          : null;

        messageData.location = {
          lat, lng,
          ...(name ? { name } : {}),
          ...(address ? { address } : {}),
          ...(gmaps ? { url: gmaps } : {}),
        };
        messageData.type = "location";
        messageData.textPreview = address || name || "Ubicación";
        messageData.media = { kind: "location" };
      }

      // === STICKER ===
      if (m.type === "sticker") {
        const stkId = m.sticker?.id || null;
        let saved = null;
        if (stkId) {
          try {
            const file = await fetchMedia(stkId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (e) { console.error("sticker error:", e); }
        }
        const media = {
          kind: "sticker",
          ...(saved?.path ? { path: saved.path } : {}),
          ...(saved?.url ? { url: saved.url } : {}),
        };
        messageData.media = Object.keys(media).length ? media : { kind: "sticker" };
      }

      // === reply del CLIENTE (context.message_id → replyTo) ===
      try {
        const ctxWamid = m?.context?.id || null;
        if (ctxWamid) {
          const replyTo = {
            id: ctxWamid,
            wamid: ctxWamid,
            type: "text",
            text: "",
            snippet: "",
            from: null,
            createdAt: null,
          };
          try {
            const ref = db.collection("conversations").doc(convId).collection("messages").doc(ctxWamid);
            const snap = await ref.get();
            if (snap.exists) {
              const orig = snap.data() || {};
              replyTo.type =
                orig?.media?.kind ||
                orig?.type ||
                (orig?.image ? "image" : orig?.audio ? "audio" : "text");
              const visible = (
                orig?.textPreview ||
                orig?.text ||
                orig?.body ||
                orig?.caption ||
                ""
              ).toString();
              replyTo.text = visible.slice(0, 200);
              replyTo.snippet = replyTo.text;
              replyTo.from = orig?.from || (orig?.direction === "out" ? "agent" : "client");
              replyTo.createdAt = orig?.timestamp || null;
            }
          } catch {}
          messageData.replyTo = replyTo;
        }
      } catch (e) {
        console.error("replyTo mapping error:", e);
      }

      // 🔒 limpieza
      if (messageData?.media && ('mime' in (messageData.media || {})) &&
          (messageData.media.mime == null || messageData.media.mime === '')) {
        delete messageData.media.mime;
      }
      const cleanMessage = JSON.parse(JSON.stringify(messageData));
      console.log("🧹 MessageData final:", JSON.stringify(cleanMessage));

      // ✅ guardar mensaje
      await convRef.collection("messages").doc(waMessageId).set(cleanMessage, { merge: true });

      console.log("🖼️ DEBUG Message saved:", {
        waMessageId,
        type: messageData.type,
        hasMedia: !!messageData.media,
        mediaKind: messageData.media?.kind,
      });

      // 🔔 PUSH FCM + ✉️ EMAIL (si hay asignado)
      try {
        const snap2 = await convRef.get();
        const assignedToUid = snap2.get("assignedToUid");
        const assignedToEmailInConv = snap2.get("assignedToEmail") || null;

        if (assignedToUid) {
          // 1) tokens FCM del asignado
          const pushDoc = await db.doc(`users/${assignedToUid}/meta/push`).get();
          const tokens = pushDoc.exists ? (pushDoc.get("tokens") || []) : [];

          // Base por entorno: PROD usa tu dominio; DEV usa localhost:5174
          const FRONTEND_BASE =
            process.env.FRONTEND_BASE_URL ||
            (process.env.VERCEL_ENV === "production"
              ? "https://crmhogarcril.com"
              : "http://localhost:5174");

          const url = `${FRONTEND_BASE}/home/${encodeURIComponent(convId)}`;

          // 2) Enviar PUSH (si hay tokens)
          if (tokens.length) {
            const admin = (await import("firebase-admin")).default;
            const resp = await admin.messaging().sendEachForMulticast({
              tokens,
              notification: {
                title: "Nuevo mensaje",
                body: text || "Toca para abrir la conversación",
              },
              data: { url, conversationId: convId },
              webpush: { fcmOptions: { link: url } },
            });

            // limpiar tokens inválidos
            const invalid = [];
            resp.responses.forEach((r, i) => { if (!r.success) invalid.push(tokens[i]); });
            if (invalid.length) {
              await db.doc(`users/${assignedToUid}/meta/push`).set(
                { tokens: tokens.filter(t => !invalid.includes(t)) },
                { merge: true }
              );
            }
          }

          // 3) Enviar EMAIL (best-effort; no rompe el webhook si falla)
          try {
            let to = assignedToEmailInConv;
            if (!to) {
              const u = await db.collection("users").doc(String(assignedToUid)).get();
              to = u.exists ? (u.get("email") || u.get("assignedToEmail") || null) : null;
            }
            if (to) {
              const who = contactData?.phone || convId;
              const preview = text || (messageData?.media?.kind ? `[${messageData.media.kind}]` : "Nuevo mensaje");
              await sendEmail({
                to,
                subject: `Nuevo mensaje de ${who}`,
                html: `
                  <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.45">
                    <p><strong>Nuevo mensaje entrante</strong></p>
                    <p><b>Conversación:</b> ${who}</p>
                    <p><b>Texto:</b> ${String(preview).replace(/</g,"&lt;")}</p>
                    <p>
                      <a href="${url}" style="display:inline-block;padding:10px 14px;background:#2E7D32;color:#fff;text-decoration:none;border-radius:6px">
                        Abrir conversación
                      </a>
                    </p>
                    <p style="color:#6b7280;font-size:12px">Si el botón no funciona, copia y pega:<br>${url}</p>
                  </div>
                `.trim()
              });
            } else {
              console.log("[email] omitido: no hay email para assignedToUid=", assignedToUid);
            }
          } catch (e) {
            console.error("[email] error enviando mail al vendedor:", e);
          }
        }
      } catch (err) {
        console.error("🔔 notify/email error:", err);
      }
    }

    // ===== ESTADOS =====
    for (const s of (value.statuses || [])) {
      const convId = normalizeE164AR(s.recipient_id);
      await db.collection("conversations").doc(convId)
        .collection("messages").doc(s.id)
        .set({ status: s.status, statusTimestamp: new Date(), rawStatus: s }, { merge: true });
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
