// api/waWebhook.js — webhook WhatsApp con media entrante robusto + replyTo en entrantes + EMAIL AL VENDEDOR
import { db, FieldValue, bucket } from "../lib/firebaseAdmin.js";
import { sendEmail } from "../lib/email.js"; // 👈 helper de email

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
  // Manejo específico para contactos: evita "mensaje vacío" en el chat
  if (m?.type === "contacts") {
    const c = Array.isArray(m.contacts) ? m.contacts[0] : undefined;
    // Nombre: formatted_name o first_name + last_name
    const formatted = c?.name?.formatted_name;
    const first = c?.name?.first_name;
    const last = c?.name?.last_name;
    const name = (formatted || [first, last].filter(Boolean).join(" ")).trim();
    // Teléfono: prioridad wa_id, luego phone, luego value
    const ph = c?.phones?.[0]?.wa_id || c?.phones?.[0]?.phone || c?.phones?.[0]?.value || "";
    const phone = ph ? `+${digits(ph)}` : "";
    const parts = [name || null, phone || null].filter(Boolean);
    if (parts.length) {
      return `📇 Contacto: ${parts.join(" · ")}`;
    }
    return "📇 Contacto"; // fallback genérico si no hay datos
  }
  return (
    m.text?.body ||
    m.interactive?.nfm_reply?.body ||
    m.interactive?.button_reply?.title ||
    m.button?.text ||
    m.image?.caption ||
    m.document?.caption ||
    m.video?.caption ||           // 👈 incluir caption de video si viene
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

/** --- NUEVO: Helper de ruteo automático por área (Villa María y otras) --- */
function pickAreaAssignee({ e164, display }) {
  const s = String(e164 || display || "");
  const raw = process.env.AREA_ROUTING_JSON || "";
  let map = {};
  try { map = JSON.parse(raw); } catch {}
  // Ajustable: por defecto solo ruteamos números AR (+549...)
  if (!s.startsWith("+549")) return null;

  // Probar prefijos configurados y elegir el más largo que matchee (353, 3573, etc.)
  const candidates = [];
  for (const k of Object.keys(map || {})) {
    if (s.startsWith("+549" + String(k))) candidates.push(k);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.length - a.length);
  const best = candidates[0];
  const out = map[best];
  if (!out || !out.uid) return null;
  return {
    uid: out.uid,
    email: out.email || null,
    name: out.name || out.email || null,
    area: best,
  };
}

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
        waId: digits(convId),

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
      // 👇 además de createdAt, guardamos firstInboundAt la PRIMERA VEZ
      if (!convSnap.exists) {
        baseConv.createdAt = FieldValue.serverTimestamp();
        baseConv.firstInboundAt = FieldValue.serverTimestamp();
      }
      await convRef.set(baseConv, { merge: true });

      /** 🔹 NUEVO BLOQUE: auto-asignación por área (solo si no tiene dueño) */
      try {
        const snapBeforeAssign = await convRef.get();
        const hasOwner = !!snapBeforeAssign.get("assignedToUid");
        if (!hasOwner) {
          const route = pickAreaAssignee({
            e164: convId,                  // "+549..."
            display: phoneDisplay || null, // "549351..." etc.
          });
          if (route?.uid) {
            const assignPayload = {
              assignedToUid: route.uid,
              ...(route.name ? { assignedToName: route.name } : {}),
              ...(route.email ? { assignedToEmail: route.email } : {}),
              assignedAt: FieldValue.serverTimestamp(),
            };
            await convRef.set(assignPayload, { merge: true });
            // (Opcional) etiqueta para debug/segmentación:
            // await convRef.set({ labels: FieldValue.arrayUnion("zonas") }, { merge: true });
            console.log("Auto-asignada por área", { convId, area: route.area, to: route.uid });
          }
        }
      } catch (e) {
        console.error("Auto-assign error:", e);
      }

      // ✅ OPT-IN al recibir un inbound
      await convRef.set(
        { optIn: true, optInAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      await contactRef.set(
        { optIn: true, optInAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      // marca inbound “ahora”
      await convRef.set(
        {
          lastInboundAt: FieldValue.serverTimestamp(),
          lastMessageText: text || "",
        },
        { merge: true }
      );

      // message base
      const messageData = {
        direction: "in",
        type: m.type || "text",
        text,
        timestamp: new Date(tsSec * 1000),
        businessPhoneId: phoneId,
        businessDisplay: phoneDisplay,
        raw: m,
      };

      // === CONTACTS ===
      if (m.type === "contacts") {
        const c = Array.isArray(m.contacts) ? m.contacts[0] : undefined;
        const formatted = c?.name?.formatted_name;
        const first = c?.name?.first_name;
        const last = c?.name?.last_name;
        const name = (formatted || [first, last].filter(Boolean).join(" ")).trim() || null;

        const ph = c?.phones?.[0]?.wa_id || c?.phones?.[0]?.phone || c?.phones?.[0]?.value || "";
        const phone = ph ? `+${digits(ph)}` : null;

        messageData.contact = stripUndefined({ name, phone, raw: c });

        if (!messageData.text || messageData.text.trim() === "") {
          const parts = [name, phone].filter(Boolean);
          messageData.text = parts.length ? `📇 Contacto: ${parts.join(" · ")}` : "📇 Contacto";
        }
        messageData.textPreview = messageData.text;
      }

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

      // === AUDIO (mejorado: url, mime, duration, voice) ===
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
          ...(Number.isFinite(m.audio?.duration) ? { duration: Number(m.audio.duration) } : {}),
          ...(m.audio?.mime_type ? { mime: m.audio.mime_type } : {}),
          ...(saved?.path ? { path: saved.path } : {}),
          ...((saved?.url || audLink) ? { url: saved?.url || audLink } : {}),
        };
        messageData.media = Object.keys(media).length ? media : { kind: "audio" };
        if (media.url) messageData.mediaUrl = media.url;
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

      // === VIDEO (nuevo, simétrico a imagen/documento) ===
      if (m.type === "video") {
        const vidId   = m.video?.id || null;
        const vidLink = m.video?.link || null;
        let saved = null;
        if (vidId) {
          try {
            const file = await fetchMedia(vidId);     // helper existente
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (e) { console.error("video error:", e); }
        }
        const media = {
          kind: "video",
          ...(m.video?.filename ? { filename: m.video.filename } : {}),
          ...(m.video?.mime_type ? { mime: m.video.mime_type } : {}),
          ...(Number.isFinite(m.video?.duration) ? { duration: Number(m.video.duration) } : {}),
          ...(saved?.path ? { path: saved.path } : {}),
          ...((saved?.url || vidLink) ? { url: saved?.url || vidLink } : {}),
        };
        messageData.media = Object.keys(media).length ? media : { kind: "video" };
        if (media.url) messageData.mediaUrl = media.url;
        // mantener caption como text si existía (extractTextFromMessage ya lo contempla)
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

      // === REACTION (nuevo) ===
      if (m.type === "reaction") {
        messageData.type = "reaction";
        messageData.reaction = {
          emoji: m.reaction?.emoji || null,
          toMessageId: m.reaction?.message_id || null,
        };
        messageData.textPreview = `❤️ reacción: ${m.reaction?.emoji || ""}`.trim();
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
