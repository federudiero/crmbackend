// api/sendMessage.js — respeta emisor elegido y cae al último que recibió el chat
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const DEFAULT_PHONE_ID = process.env.META_WA_PHONE_ID || "";
const TOKEN = process.env.META_WA_TOKEN || "";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ---------- headers ----------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

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
async function resolvePhoneIdFor(toRaw, explicitPhoneId, defaultPhoneId) {
  if (explicitPhoneId) return explicitPhoneId; // front manda fromWaPhoneId
  const convId = normalizeE164AR(toRaw);
  if (convId) {
    try {
      const snap = await db.collection("conversations").doc(convId).get();
      const fromConv = snap.exists ? snap.data()?.lastInboundPhoneId : null;
      if (fromConv) return fromConv; // mismo número que recibió
    } catch { /* ignore */ }
  }
  return defaultPhoneId;
}

// ---------- handler ----------
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "method_not_allowed" });

  try {
    if (!TOKEN) return res.status(500).json({ error: "server_misconfigured" });

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    let { to, text, template, fromWaPhoneId, phoneId } = body;

    if (!to) return res.status(400).json({ error: "missing_to" });
    if (!text && !template) return res.status(400).json({ error: "missing_text_or_template" });

    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const raw of recipients) {
      const PHONE_ID = await resolvePhoneIdFor(raw, (fromWaPhoneId || phoneId), DEFAULT_PHONE_ID);
      if (!PHONE_ID) return res.status(500).json({ error: "no_phone_id_available" });

      const cands = candidatesForSendAR(raw);
      let delivered = null, usedToDigits = null, usedVariant = null, lastErr = null;

      for (const cand of cands) {
        const payload = template
          ? { type: "template", template }
          : { type: "text", text: { body: typeof text === "string" ? text : (text?.body || ""), preview_url: false } };

        const r = await sendToGraph(PHONE_ID, cand, payload);
        if (r.ok) { delivered = r.json; usedToDigits = cand; usedVariant = cand.startsWith("549") ? "549" : "5415"; break; }
        lastErr = r.json;
        if (r?.json?.error?.code !== 131030) break; // si no es sandbox allow-list, no insistir
      }

      const convId = normalizeE164AR(usedToDigits || cands[0]);
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
        to: convId,
        toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
        sendVariant: usedVariant || undefined,
        businessPhoneId: PHONE_ID,
        status: delivered ? "sent" : "error",
        raw: delivered || undefined,
        error: delivered ? undefined : (lastErr || { message: "send_failed" }),
      };
      if (!template) msgDoc.text = typeof text === "string" ? text : (text?.body || "");
      else msgDoc.template = template?.name || null;

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);
      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      results.push({ to: convId, ok: !!delivered, id: wamid, phoneId: PHONE_ID, sendVariant: msgDoc.sendVariant, error: msgDoc.error });
    }

    return res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
