// backend/api/sendMessage.js

// ====== CORS ======
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*", // en prod poné tu dominio
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const setCors = (res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
};

// ====== Constantes ======
const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const DEFAULT_PHONE_ID = process.env.META_WA_PHONE_ID || "";
const TOKEN = process.env.META_WA_TOKEN || "";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";

// ---------- helpers de números (AR) ----------
const digits = (s) => String(s || "").replace(/\D+/g, "");

function normalizeE164AR(raw) {
  let d = digits(raw);
  if (!d) return "";
  if (d.startsWith("549")) return `+${d}`;
  const m5415 = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, local] = m5415;
    return `+549${area}${local}`;
  }
  if (d.startsWith("54")) return `+${d}`;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  return `+${d}`;
}

function candidatesForSendAR(toRaw) {
  const d0 = digits(toRaw);

  if (/^549\d+$/.test(d0)) {
    const areaLocal = d0.slice(3);
    const m = areaLocal.match(/^(\d{2,4})(\d+)$/);
    if (!m) return [d0];
    const [, area, rest] = m;
    return PREFER_5415 ? [`54${area}15${rest}`, d0] : [d0, `54${area}15${rest}`];
  }

  const m5415 = d0.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, rest] = m5415;
    return PREFER_5415 ? [d0, `549${area}${rest}`] : [`549${area}${rest}`, d0];
  }

  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  const area = /^11\d{8}$/.test(d) ? d.slice(0, 2) : d.slice(0, 3);
  const local = d.slice(area.length);
  const v549 = `549${area}${local}`;
  const v5415 = `54${area}15${local}`;
  return PREFER_5415 ? [v5415, v549] : [v549, v5415];
}

// ---------- Graph API ----------
async function sendToGraph(phoneId, toDigits, payload) {
  const url = `${GRAPH_BASE}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// ---------- resolver emisor ----------
async function resolvePhoneIdFor(db, toRaw, explicitPhoneId, defaultPhoneId) {
  if (explicitPhoneId) return explicitPhoneId;

  const convId = normalizeE164AR(toRaw);
  if (convId) {
    try {
      const snap = await db.collection("conversations").doc(convId).get();
      const fromConv = snap.exists ? snap.data()?.lastInboundPhoneId : null;
      if (fromConv) return fromConv;
    } catch {
      /* ignore */
    }
  }
  return defaultPhoneId;
}

// ---------- helper preview ----------
function buildPreviewForSent({ sentType, text, template, image, audio, document }) {
  if (sentType === "text") {
    return typeof text === "string" ? text : (text?.body || "");
  }

  if (sentType === "template") {
    try {
      const comps = Array.isArray(template?.components) ? template.components : [];
      const params = comps?.[0]?.parameters || [];
      const p = (i) => (typeof params[i]?.text === "string" ? params[i].text : "");

      const name = String(template?.name || "").toLowerCase();
      const envReengage = (process.env.VITE_WA_REENGAGE_TEMPLATE || "reengage_free_text").toLowerCase();
      const isReengage = name === envReengage || name === "reengage_free_text";

      if (isReengage) {
        const p1 = p(0) || "¡Hola!";
        const p2 = p(1) || "Equipo de Ventas";
        const p3 = p(2) || "Tu Comercio";
        return `¡Hola ${p1}! Soy ${p2} de ${p3}.`;
      }

      const parts = params.map((x) => (typeof x?.text === "string" ? x.text : "")).filter(Boolean);
      return parts.length ? `[Plantilla ${template?.name}] ${parts.join(" • ")}` : `[Plantilla ${template?.name}]`;
    } catch {
      return `[Plantilla ${template?.name || "enviada"}]`;
    }
  }

  if (sentType === "image") return image?.caption || "[Imagen]";
  if (sentType === "audio") return "[Audio]";
  if (sentType === "document") return document?.caption || "[Documento]";
  return "";
}

// ====== HANDLER ======
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    if (!TOKEN) return res.status(500).json({ error: "server_misconfigured" });

    // Import dinámico
    const fb = await import("../lib/firebaseAdmin.js");
    const admin = fb.default;
    const { db, FieldValue } = fb;

    // ✅ Auth Firebase (obligatorio)
    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const senderUid = decoded?.uid || null;
    const senderEmail = (decoded?.email || "").toLowerCase();

    // Body robusto
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body || "{}"); } catch { body = {}; }
    } else if (!body || typeof body !== "object") {
      body = {};
    }

    let {
      to,
      text,
      template,
      image,
      audio,
      document,
      fromWaPhoneId,
      phoneId,
      replyTo,
      sellerName, // opcional
    } = body;

    if (!to) return res.status(400).json({ error: "missing_to" });
    if (!text && !template && !image && !audio && !document) {
      return res.status(400).json({ error: "missing_text_or_template_or_media" });
    }

    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const raw of recipients) {
      const PHONE_ID = await resolvePhoneIdFor(db, raw, (fromWaPhoneId || phoneId), DEFAULT_PHONE_ID);
      if (!PHONE_ID) return res.status(500).json({ error: "no_phone_id_available" });

      const cands = candidatesForSendAR(raw);
      let delivered = null, usedToDigits = null, usedVariant = null, lastErr = null;

      for (const cand of cands) {
        let payload;
        if (image) payload = { type: "image", image };
        else if (audio) payload = { type: "audio", audio };
        else if (document) payload = { type: "document", document };
        else if (template) payload = { type: "template", template };
        else payload = { type: "text", text: { body: typeof text === "string" ? text : (text?.body || ""), preview_url: false } };

        const ctxId = replyTo?.wamid || replyTo?.id;
        if (ctxId) payload.context = { message_id: String(ctxId) };

        const r = await sendToGraph(PHONE_ID, cand, payload);
        if (r.ok) {
          delivered = r.json;
          usedToDigits = cand;
          usedVariant = cand.startsWith("549") ? "549" : "5415";
          break;
        }
        lastErr = r.json;
        if (r?.json?.error?.code !== 131030) break;
      }

      const convId = normalizeE164AR(usedToDigits || cands[0]);
      const convRef = db.collection("conversations").doc(convId);

      await convRef.set({ contactId: convId, lastMessageAt: FieldValue.serverTimestamp() }, { merge: true });

      const wamid = delivered?.messages?.[0]?.id || `out_${Date.now()}`;
      const sentType = image ? "image" : audio ? "audio" : document ? "document" : (template ? "template" : "text");

      const msgDoc = {
        direction: "out",
        type: sentType,
        timestamp: FieldValue.serverTimestamp(),
        to: convId,
        toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
        sendVariant: usedVariant || undefined,
        businessPhoneId: PHONE_ID,
        status: delivered ? "sent" : "error",
        raw: delivered || undefined,
        error: delivered ? undefined : (lastErr || { message: "send_failed" }),

        // ✅ Auditoría
        sentByUid: senderUid || undefined,
        sentByEmail: senderEmail || undefined,
        sellerName: sellerName || undefined,
      };

      if (sentType === "text") {
        msgDoc.text = typeof text === "string" ? text : (text?.body || "");
      }

      if (sentType === "template") {
        msgDoc.template = {
          name: template?.name || null,
          language: template?.language || null,
          components: Array.isArray(template?.components) ? template.components : [],
        };

        try {
          const name = String(msgDoc?.template?.name || "").toLowerCase();
          const envReengage = (process.env.VITE_WA_REENGAGE_TEMPLATE || "reengage_free_text").toLowerCase();
          const isReengage = name === envReengage || name === "reengage_free_text";

          const comps = msgDoc.template.components?.[0]?.parameters || [];
          const p = (i) => (typeof comps[i]?.text === "string" ? comps[i].text : "");

          if (isReengage) {
            const p1 = p(0) || "¡Hola!";
            const p2 = p(1) || "Equipo de Ventas";
            const p3 = p(2) || "Tu Comercio";
            msgDoc.textPreview =
              `¡Hola ${p1}! Soy ${p2} de ${p3}.\n` +
              `Te escribo para retomar tu consulta ya que pasaron más de 24 horas desde el último mensaje.\n` +
              `Respondé a este mensaje para continuar la conversación.`;
          } else {
            const parts = comps.map((x) => (typeof x?.text === "string" ? x.text : "")).filter(Boolean);
            const label = msgDoc?.template?.name || "template";
            msgDoc.textPreview = parts.length ? `[Plantilla ${label}] ${parts.join(" • ")}` : `[Plantilla ${label}]`;
          }
        } catch {
          const label = msgDoc?.template?.name || "template";
          msgDoc.textPreview = `[Plantilla ${label}]`;
        }
      }

      if (sentType === "image") {
        const imgUrl = image?.link || image?.url || null;
        msgDoc.media = {
          kind: "image",
          ...(imgUrl ? { link: imgUrl, url: imgUrl } : {}),
          ...(image?.id ? { id: image.id } : {}),
          ...(image?.caption ? { caption: image.caption } : {}),
        };
        if (imgUrl) msgDoc.mediaUrl = imgUrl;
      }

      if (sentType === "audio") {
        const audUrl = audio?.link || audio?.url || null;
        msgDoc.media = {
          kind: "audio",
          ...(audUrl ? { link: audUrl, url: audUrl } : {}),
          ...(audio?.id ? { id: audio.id } : {}),
        };
        if (audUrl) msgDoc.mediaUrl = audUrl;
      }

      if (sentType === "document") {
        const docUrl = document?.link || document?.url || null;
        msgDoc.media = {
          kind: "document",
          ...(docUrl ? { link: docUrl, url: docUrl } : {}),
          ...(document?.id ? { id: document.id } : {}),
          ...(document?.caption ? { caption: document.caption } : {}),
          ...(document?.filename ? { filename: document.filename } : {}),
        };
        if (docUrl) msgDoc.mediaUrl = docUrl;
      }

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);

      if (replyTo) {
        msgDoc.replyTo = {
          id: replyTo.id || null,
          type: replyTo.type || "text",
          text: (replyTo.text || replyTo.snippet || "").slice(0, 200),
          snippet: (replyTo.snippet || replyTo.text || "").slice(0, 200),
          wamid: replyTo.wamid || null,
          from: replyTo.from || null,
          createdAt: replyTo.createdAt || null,
        };
      }

      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      const preview = buildPreviewForSent({ sentType, text, template, image, audio, document });

      await convRef.set(
        {
          contactId: convId,
          lastMessageAt: FieldValue.serverTimestamp(),
          lastMessageText: String(preview || "").slice(0, 500),
          lastMessageDirection: "out",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      results.push({
        to: convId,
        ok: !!delivered,
        id: wamid,
        phoneId: PHONE_ID,
        sendVariant: msgDoc.sendVariant,
        error: msgDoc.error,
      });
    }

    return res.status(200).json({ ok: results.every((r) => r.ok), results });
  } catch (err) {
    setCors(res);
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: err.message || "internal_error" });
  }
}
