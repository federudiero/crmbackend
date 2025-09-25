// backend/api/sendMessage.js

// ====== CORS ======
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*", // poné tu dominio en prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const setCors = (res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
};

// ====== Constantes de Graph / env (leer env acá no rompe OPTIONS) ======
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
  if (m5415) { const [, area, local] = m5415; return `+549${area}${local}`; }
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
  if (explicitPhoneId) return explicitPhoneId; // front manda fromWaPhoneId/phoneId
  const convId = normalizeE164AR(toRaw);
  if (convId) {
    try {
      const snap = await db.collection("conversations").doc(convId).get();
      const fromConv = snap.exists ? snap.data()?.lastInboundPhoneId : null;
      if (fromConv) return fromConv; // usar el mismo número que recibió
    } catch { /* ignore */ }
  }
  return defaultPhoneId;
}

// ====== HANDLER ======
export default async function handler(req, res) {
  setCors(res);

  // Preflight siempre 204, sin inicializar nada
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    if (!TOKEN) return res.status(500).json({ error: "server_misconfigured" });

    // ⚠️ Import dinámico para que si firebaseAdmin.js rompe, no rompa el OPTIONS
    const { db, FieldValue } = await import("../lib/firebaseAdmin.js");

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    let { to, text, template, image, audio, fromWaPhoneId, phoneId } = body;

    if (!to) return res.status(400).json({ error: "missing_to" });
    if (!text && !template && !image && !audio) {
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
        // --- Selección de payload (media > template > text) ---
        let payload;
        if (image) {
          payload = { type: "image", image };
        } else if (audio) {
          payload = { type: "audio", audio };
        } else if (template) {
          payload = { type: "template", template };
        } else {
          payload = { type: "text", text: { body: typeof text === "string" ? text : (text?.body || ""), preview_url: false } };
        }

        const r = await sendToGraph(PHONE_ID, cand, payload);
        if (r.ok) {
          delivered = r.json;
          usedToDigits = cand;
          usedVariant = cand.startsWith("549") ? "549" : "5415";
          break; // al primer éxito, salimos
        }
        lastErr = r.json;
        // si no es sandbox allow-list, no insistir
        if (r?.json?.error?.code !== 131030) break;
      }

      const convId = normalizeE164AR(usedToDigits || cands[0]);
      const convRef = db.collection("conversations").doc(convId);
      await convRef.set(
        { contactId: convId, lastMessageAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      const wamid = delivered?.messages?.[0]?.id || `out_${Date.now()}`;

      // tipo realmente enviado
      const sentType = image ? "image" : audio ? "audio" : (template ? "template" : "text");

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
      };

      if (sentType === "text") {
        msgDoc.text = typeof text === "string" ? text : (text?.body || "");
      }
      if (sentType === "template") {
        msgDoc.template = template?.name || null;
      }
      if (sentType === "image") {
        msgDoc.media = {
          kind: "image",
          ...(image?.link ? { link: image.link } : {}),
          ...(image?.id ? { id: image.id } : {}),
          ...(image?.caption ? { caption: image.caption } : {}),
        };
      }
      if (sentType === "audio") {
        msgDoc.media = {
          kind: "audio",
          ...(audio?.link ? { link: audio.link } : {}),
          ...(audio?.id ? { id: audio.id } : {}),
        };
      }

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);
      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      results.push({
        to: convId,
        ok: !!delivered,
        id: wamid,
        phoneId: PHONE_ID,
        sendVariant: msgDoc.sendVariant,
        error: msgDoc.error,
      });
    }

    return res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    // siempre devolver CORS también en error
    setCors(res);
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: err.message || "internal_error" });
  }
}
