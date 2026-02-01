// api/waWebhook.js — webhook WhatsApp con media entrante robusto + replyTo en entrantes + EMAIL AL VENDEDOR
import { db, FieldValue, bucket } from "../lib/firebaseAdmin.js";
import { sendEmail } from "../lib/email.js";
// import crypto from "crypto"; // (opcional) para firma webhook

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function safeParseBody(req) {
  try {
    return typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

const digits = (s) => String(s || "").replace(/\D/g, "");

// ✅ fix: si no hay dígitos, no devuelvas "+"
function normalizeE164AR(waIdOrPhone) {
  const d = digits(waIdOrPhone);
  if (!d) return "";
  if (d.startsWith("549")) return `+${d}`;
  const m = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m) {
    const [, area, local] = m;
    return `+549${area}${local}`;
  }
  if (d.startsWith("54")) return `+${d}`;
  return `+${d}`;
}

function extractTextFromMessage(m) {
  // Manejo específico para contactos: evita "mensaje vacío" en el chat
  if (m?.type === "contacts") {
    const c = Array.isArray(m.contacts) ? m.contacts[0] : undefined;

    const formatted = c?.name?.formatted_name;
    const first = c?.name?.first_name;
    const last = c?.name?.last_name;
    const name = (formatted || [first, last].filter(Boolean).join(" ")).trim();

    const ph =
      c?.phones?.[0]?.wa_id ||
      c?.phones?.[0]?.phone ||
      c?.phones?.[0]?.value ||
      "";
    const phone = ph ? `+${digits(ph)}` : "";

    const parts = [name || null, phone || null].filter(Boolean);
    if (parts.length) return `📇 Contacto: ${parts.join(" · ")}`;
    return "📇 Contacto";
  }

  return (
    m.text?.body ||
    m.interactive?.nfm_reply?.body ||
    m.interactive?.button_reply?.title ||
    m.button?.text ||
    m.image?.caption ||
    m.document?.caption ||
    m.video?.caption ||
    ""
  );
}

// ✅ stripUndefined robusto:
// - preserva Date
// - preserva cualquier objeto NO "plain" (ej: FieldValue.serverTimestamp(), Timestamp, GeoPoint, etc.)
// - filtra undefined en arrays
function isPlainObject(o) {
  if (!o || typeof o !== "object") return false;
  return Object.getPrototypeOf(o) === Object.prototype;
}

function stripUndefined(obj) {
  if (obj === undefined) return undefined;
  if (obj === null) return null;

  if (obj instanceof Date) return obj;

  // preserva objetos especiales del SDK (FieldValue, Timestamp, GeoPoint, Buffer, etc.)
  if (typeof obj === "object" && !Array.isArray(obj) && !isPlainObject(obj)) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(stripUndefined).filter((v) => v !== undefined);
  }

  if (typeof obj !== "object") return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const vv = stripUndefined(v);
    if (vv !== undefined) out[k] = vv;
  }
  return out;
}

// === Helpers media ===
const GRAPH = "https://graph.facebook.com/v23.0";
const WA_TOKEN = process.env.META_WA_TOKEN;

if (!WA_TOKEN) {
  console.warn("[waWebhook] META_WA_TOKEN missing → media download will fail.");
}

/** --- Helper de ruteo automático por área (Villa María y otras) --- */
function pickAreaAssignee({ e164, display }) {
  const s = String(e164 || display || "");
  const raw = process.env.AREA_ROUTING_JSON || "";
  let map = {};
  try {
    map = JSON.parse(raw);
  } catch { }

  if (!s.startsWith("+549")) return null;

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
  if (!WA_TOKEN) return null;

  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 5000;

  console.log(
    `🔍 [fetchMedia] mediaId=${mediaId} intento ${retryCount + 1}/${MAX_RETRIES + 1}`
  );

  try {
    // 1) Metadata
    const metaController = new AbortController();
    const metaTimeout = setTimeout(() => metaController.abort(), TIMEOUT_MS);

    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      signal: metaController.signal,
    });

    clearTimeout(metaTimeout);
    console.log(`📊 [fetchMedia] Metadata status=${metaRes.status}`);

    if (!metaRes.ok) {
      const t = await metaRes.text();
      console.error(`❌ [fetchMedia] Metadata error ${metaRes.status}: ${t}`);

      if (metaRes.status === 400 && retryCount < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 120));
        return fetchMedia(mediaId, retryCount + 1);
      }
      return null;
    }

    const meta = await metaRes.json();
    if (!meta?.url) return null;

    // 2) Binario
    const binController = new AbortController();
    const binTimeout = setTimeout(() => binController.abort(), TIMEOUT_MS);

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      signal: binController.signal,
    });

    clearTimeout(binTimeout);
    console.log(`📊 [fetchMedia] Binario status=${binRes.status}`);

    if (!binRes.ok) {
      const t = await binRes.text();
      console.error(`❌ [fetchMedia] Binario error ${binRes.status}: ${t}`);

      if (retryCount < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 120));
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
    console.error(`💥 [fetchMedia] Error:`, err?.message || err);

    if (
      retryCount < MAX_RETRIES &&
      (err?.name === "AbortError" || err?.code === "ECONNRESET")
    ) {
      await new Promise((r) => setTimeout(r, 200));
      return fetchMedia(mediaId, retryCount + 1);
    }
    return null;
  }
}

/** Sube a Storage y devuelve URL firmada larga */
async function saveToStorageAndSign(convId, waMessageId, mime, buf) {
  const ext = (mime.split("/")[1] || "bin").split(";")[0];
  const path = `public/conversations/${convId}/${waMessageId}.${ext}`;
  await bucket.file(path).save(buf, { contentType: mime });
  const [url] = await bucket.file(path).getSignedUrl({
    action: "read",
    expires: "3025-01-01",
  });
  return { path, url };
}

export default async function handler(req, res) {
  cors(res);

  // Verificación de webhook (challenge)
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
    const body = safeParseBody(req);
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const meta = value.metadata || {};
    const phoneId = meta.phone_number_id || null;
    const phoneDisplay = meta.display_phone_number || null;
    const phoneDisplayE164 = normalizeE164AR(phoneDisplay);

    // ===== MENSAJES ENTRANTES =====
    for (const m of value.messages || []) {
      const convId = normalizeE164AR(m.from);
      const waMessageId = m.id;
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const eventTsMs = Number.isFinite(tsSec) ? tsSec * 1000 : Date.now();
      const text = extractTextFromMessage(m);

      if (!convId || !waMessageId) {
        console.warn("[waWebhook] skip message missing convId/waMessageId", { convId, waMessageId });
        continue;
      }

      const convRef = db.collection("conversations").doc(convId);

      // contact
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();

      const contactData = {
        phone: convId,
        waId: digits(convId),
        updatedAt: FieldValue.serverTimestamp(),
        optIn: true,
        optInAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(stripUndefined(contactData), { merge: true });

      // conversation + auto-assign: ✅ transaction (evita carreras)
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(convRef);
        const isNew = !snap.exists;
        const hasOwner = !!snap.get("assignedToUid");

        const now = FieldValue.serverTimestamp();

        const prevLastMsgTs = Number(snap.get("lastMessageTsMs") || 0);
        const prevLastInboundTs = Number(snap.get("lastInboundTsMs") || 0);

        const shouldUpdateLastMessage = eventTsMs >= prevLastMsgTs;
        const shouldUpdateLastInbound = eventTsMs >= prevLastInboundTs;

        const baseConv = {
          contactId: convId,

          // inbound meta
          lastInboundPhoneId: phoneId || null,
          ...(phoneDisplay ? { lastInboundDisplayRaw: String(phoneDisplay) } : {}),
          ...(phoneDisplayE164 ? { lastInboundDisplay: phoneDisplayE164 } : {}),

          // opt-in
          optIn: true,
          optInAt: now,

          updatedAt: now,
        };

        if (isNew) {
          baseConv.createdAt = now;
          baseConv.firstInboundAt = now;
        }

        if (shouldUpdateLastInbound) {
          baseConv.lastInboundAt = now;
          baseConv.lastInboundTsMs = eventTsMs;
        }

        if (shouldUpdateLastMessage) {
          baseConv.lastMessageAt = now;
          baseConv.lastMessageText = text || "";
          baseConv.lastMessageDirection = "in";
          baseConv.lastMessageType = m.type || "text";
          baseConv.lastMessageId = waMessageId;
          baseConv.lastMessageTsMs = eventTsMs;
        }

        tx.set(convRef, stripUndefined(baseConv), { merge: true });

        // auto-asignación por área (solo si no tiene dueño)
        if (!hasOwner) {
          const route = pickAreaAssignee({
            e164: convId,
            display: phoneDisplay || null,
          });

          if (route?.uid) {
            const assignPayload = {
              assignedToUid: route.uid,
              ...(route.name ? { assignedToName: route.name } : {}),
              ...(route.email ? { assignedToEmail: route.email } : {}),
              assignedAt: now,
            };
            tx.set(convRef, stripUndefined(assignPayload), { merge: true });

            console.log("Auto-asignada por área", {
              convId,
              area: route.area,
              to: route.uid,
            });
          }
        }
      });

      // message base
      const messageData = {
        direction: "in",
        type: m.type || "text",
        text,
        timestamp: new Date(eventTsMs),
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

        const ph =
          c?.phones?.[0]?.wa_id ||
          c?.phones?.[0]?.phone ||
          c?.phones?.[0]?.value ||
          "";
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
        const imgId = m.image?.id || null;
        const imgLink = m.image?.link || null;

        let saved = null;
        if (imgId) {
          try {
            const file = await fetchMedia(imgId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
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
        const audId = m.audio?.id || null;
        const audLink = m.audio?.link || null;

        let saved = null;
        if (audId) {
          try {
            const file = await fetchMedia(audId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (e) {
            console.error("audio error:", e);
          }
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
        const docId = m.document?.id || null;
        const docLink = m.document?.link || null;

        let saved = null;
        if (docId) {
          try {
            const file = await fetchMedia(docId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
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
          messageData.media = { kind: "document", ...(media.filename ? { filename: media.filename } : {}) };
          messageData.hasMedia = true;
          messageData.mediaError = "DOWNLOAD_FAILED_EXPIRED";
        } else {
          messageData.media = media;
          messageData.mediaUrl = media.url;
        }
      }

      // === VIDEO ===
      if (m.type === "video") {
        const vidId = m.video?.id || null;
        const vidLink = m.video?.link || null;

        let saved = null;
        if (vidId) {
          try {
            const file = await fetchMedia(vidId);
            if (file) saved = await saveToStorageAndSign(convId, waMessageId, file.mime, file.buf);
          } catch (e) {
            console.error("video error:", e);
          }
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
      }

      // === LOCATION ===
      if (m.type === "location") {
        const lat = Number(m?.location?.latitude);
        const lng = Number(m?.location?.longitude);
        const name = m?.location?.name || null;
        const address = m?.location?.address || null;
        const gmaps =
          Number.isFinite(lat) && Number.isFinite(lng)
            ? `https://www.google.com/maps?q=${lat},${lng}`
            : null;

        messageData.location = stripUndefined({
          lat,
          lng,
          ...(name ? { name } : {}),
          ...(address ? { address } : {}),
          ...(gmaps ? { url: gmaps } : {}),
        });

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
          } catch (e) {
            console.error("sticker error:", e);
          }
        }

        const media = {
          kind: "sticker",
          ...(saved?.path ? { path: saved.path } : {}),
          ...(saved?.url ? { url: saved.url } : {}),
        };

        messageData.media = Object.keys(media).length ? media : { kind: "sticker" };
      }

      // === REACTION ===
      if (m.type === "reaction") {
        messageData.type = "reaction";
        messageData.reaction = stripUndefined({
          emoji: m.reaction?.emoji || null,
          toMessageId: m.reaction?.message_id || null,
        });
        messageData.textPreview = `❤️ reacción: ${m.reaction?.emoji || ""}`.trim();
      }

      // === reply del CLIENTE (context.id → replyTo) ===
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
            const ref = convRef.collection("messages").doc(ctxWamid);
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
          } catch { }

          messageData.replyTo = stripUndefined(replyTo);
        }
      } catch (e) {
        console.error("replyTo mapping error:", e);
      }

      // Limpieza mime vacío
      if (
        messageData?.media &&
        "mime" in (messageData.media || {}) &&
        (messageData.media.mime == null || messageData.media.mime === "")
      ) {
        delete messageData.media.mime;
      }

      // ✅ guardar mensaje (SIN stringify)
      const cleanMessage = stripUndefined(messageData);

      await convRef.collection("messages").doc(waMessageId).set(cleanMessage, { merge: true });

      // 🔔 PUSH FCM + ✉️ EMAIL (si hay asignado)
      try {
        const snap2 = await convRef.get();
        const assignedToUid = snap2.get("assignedToUid");
        const assignedToEmailInConv = snap2.get("assignedToEmail") || null;

        if (assignedToUid) {
          const pushDoc = await db.doc(`users/${assignedToUid}/meta/push`).get();
          const tokens = pushDoc.exists ? pushDoc.get("tokens") || [] : [];

          const FRONTEND_BASE =
            process.env.FRONTEND_BASE_URL ||
            (process.env.VERCEL_ENV === "production"
              ? "https://crmhogarcril.com"
              : "http://localhost:5174");

          const url = `${FRONTEND_BASE}/home/${encodeURIComponent(convId)}`;

          // PUSH
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

            const invalid = [];
            resp.responses.forEach((r, i) => {
              if (!r.success) invalid.push(tokens[i]);
            });

            if (invalid.length) {
              await db.doc(`users/${assignedToUid}/meta/push`).set(
                { tokens: tokens.filter((t) => !invalid.includes(t)) },
                { merge: true }
              );
            }
          }

          // EMAIL (best-effort)
          try {
            let to = assignedToEmailInConv;
            if (!to) {
              const u = await db.collection("users").doc(String(assignedToUid)).get();
              to = u.exists ? (u.get("email") || u.get("assignedToEmail") || null) : null;
            }

            if (to) {
              const who = convId;
              const preview =
                text || (cleanMessage?.media?.kind ? `[${cleanMessage.media.kind}]` : "Nuevo mensaje");

              await sendEmail({
                to,
                subject: `Nuevo mensaje de ${who}`,
                html: `
                  <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;line-height:1.45">
                    <p><strong>Nuevo mensaje entrante</strong></p>
                    <p><b>Conversación:</b> ${who}</p>
                    <p><b>Texto:</b> ${String(preview).replace(/</g, "&lt;")}</p>
                    <p>
                      <a href="${url}" style="display:inline-block;padding:10px 14px;background:#2E7D32;color:#fff;text-decoration:none;border-radius:6px">
                        Abrir conversación
                      </a>
                    </p>
                    <p style="color:#6b7280;font-size:12px">Si el botón no funciona, copia y pega:<br>${url}</p>
                  </div>
                `.trim(),
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
    for (const s of value.statuses || []) {
      const convId = normalizeE164AR(s.recipient_id);
      if (!convId || !s?.id) continue;

      const statusAt = s.timestamp ? new Date(Number(s.timestamp) * 1000) : null;

      await db
        .collection("conversations")
        .doc(convId)
        .collection("messages")
        .doc(s.id)
        .set(
          stripUndefined({
            status: s.status,
            statusTimestamp: FieldValue.serverTimestamp(), // server time
            ...(statusAt ? { statusAt } : {}),            // event time si viene
            rawStatus: s,
          }),
          { merge: true }
        );
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
