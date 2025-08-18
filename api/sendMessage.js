// api/sendMessage.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const PHONE_ID = process.env.META_WA_PHONE_ID;
const TOKEN    = process.env.META_WA_TOKEN;
// Si estás en sandbox y Meta guarda “+54 (área) 15 (local)”, poné 1
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ---------- Helpers ----------
const digits = (s) => String(s || "").replace(/\D/g, "");

// Canónico AR para el hilo = +549 AAAXXXXXXX
function normalizeE164AR(raw) {
  let d = digits(raw);
  if (d.startsWith("549")) return `+${d}`;
  const m = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m) {
    const [, area, local] = m;
    return `+549${area}${local}`;
  }
  if (d.startsWith("54")) return `+${d}`;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  return `+${d}`;
}

/**
 * Genera candidatos de envío para AR:
 * - 54..15.. y 549.. (en ese orden si PREFER_5415=1)
 * - siempre SIN '+'
 */
function candidatesForSendAR(toRaw) {
  const d0 = digits(toRaw);

  const m5415 = d0.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, rest] = m5415;
    return PREFER_5415 ? [d0, `549${area}${rest}`] : [`549${area}${rest}`, d0];
  }

  const m549 = d0.match(/^549(\d{2,4})(\d+)$/);
  if (m549) {
    const [, area, rest] = m549;
    return PREFER_5415 ? [`54${area}15${rest}`, d0] : [d0, `54${area}15${rest}`];
  }

  // Local/otro: construyo ambas
  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  let areaLen = 3;
  if (/^11\d{8}$/.test(d)) areaLen = 2; // CABA
  const area  = d.slice(0, areaLen);
  const local = d.slice(areaLen);

  return PREFER_5415
    ? [`54${area}15${local}`, `549${area}${local}`]
    : [`549${area}${local}`, `54${area}15${local}`];
}

async function sendToGraph(toDigits, payload) {
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits, // sin '+'
      ...payload,
    }),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "method_not_allowed" });

  try {
    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({ error: "server_misconfigured" });
    }

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    let { to, text, template } = body;

    if (!to) return res.status(400).json({ error: "missing_to" });
    if (!text && !template) return res.status(400).json({ error: "missing_text_or_template" });

    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const raw of recipients) {
      const cands = candidatesForSendAR(raw);

      let delivered = null;
      let usedToDigits = null;   // dígitos exactos usados para enviar
      let usedVariant = null;    // "549" o "5415"
      let lastErr = null;

      for (const cand of cands) {
        const payload = template
          ? { type: "template", template }
          : { type: "text", text: { body: typeof text === "string" ? text : text?.body, preview_url: false } };

        const r = await sendToGraph(cand, payload);
        console.log("WA send", { to: cand, ok: r.ok, status: r.status, code: r?.json?.error?.code });

        if (r.ok) {
          delivered = r.json;
          usedToDigits = cand;
          usedVariant = cand.startsWith("549") ? "549" : "5415";
          break;
        }

        lastErr = r.json;
        const code = r?.json?.error?.code;
        // 131030 = not in allowed list (sandbox) -> probamos el siguiente
        if (code !== 131030) break;
      }

      // Conversación SIEMPRE en canónico +549...
      const convId  = normalizeE164AR(usedToDigits || cands[0]);
      const convRef = db.collection("conversations").doc(convId);

      await convRef.set(
        { contactId: convId, lastMessageAt: FieldValue.serverTimestamp() },
        { merge: true }
      );

      const wamid = delivered?.messages?.[0]?.id || `out_${Date.now()}`;

      const msgDoc = {
        direction: "out",
        type: template ? "template" : "text",
        timestamp: FieldValue.serverTimestamp(),
        to: convId,                             // 🔒 siempre +549...
        toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
        sendVariant: usedVariant || undefined,  // "549" | "5415"
        status: delivered ? "sent" : "error",
        raw: delivered || undefined,
        error: delivered ? undefined : (lastErr || { message: "send_failed" }),
      };

      if (!template) msgDoc.text = typeof text === "string" ? text : text?.body || "";
      else           msgDoc.template = template?.name || null;

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);
      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      // devolvemos SIEMPRE el hilo canónico para que el front navegue ahí
      results.push({ to: convId, ok: !!delivered, id: wamid, error: msgDoc.error, sendVariant: msgDoc.sendVariant });
    }

    return res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
