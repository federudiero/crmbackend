// api/sendMessage.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID = process.env.META_WA_PHONE_ID;
const TOKEN = process.env.META_WA_TOKEN;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Helpers de normalización para Argentina ---
function digits(s) { return String(s || "").replace(/\D/g, ""); }

// E.164 móvil AR sin '+' -> 549AAAXXXXXXX
function to549(raw) {
  let d = digits(raw);
  // quitar 00 internacional
  if (d.startsWith("00")) d = d.slice(2);
  // quitar código país si viene repetido
  if (d.startsWith("54")) d = d.slice(2);
  // quitar 0 de área
  if (d.startsWith("0")) d = d.slice(1);
  // quitar '15' después del área (heurística: área 2-4 dígitos)
  d = d.replace(/^(\d{2,4})15/, "$1");
  // asegurar móvil con '9' delante
  if (!d.startsWith("9")) d = "9" + d;
  return "54" + d; // 549...
}

// Variante “54 + área + 15 + número” (como muestra Meta en el Getting Started)
function to5415(raw) {
  let d = digits(raw);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  // heurística de área: 3 dígitos (p.ej. 351). Si no alcanza, usa 2.
  let areaLen = d.length >= 10 ? 3 : 2;
  const area = d.slice(0, areaLen);
  let local = d.slice(areaLen);
  // si ya venía con 15 al comienzo del local, no dupliques
  if (!local.startsWith("15")) local = "15" + local;
  return "54" + area + local;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { cors(res); return res.status(204).send(""); }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    cors(res);

    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({ error: "missing_env", detail: "META_WA_PHONE_ID o META_WA_TOKEN no configurados" });
    }

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const { to, text, conversationId } = body;
    if (!to || !text) return res.status(400).json({ error: "to y text son requeridos" });

    // 1) intento con 549... (sin '+', solo dígitos)
    const to549Digits = to549(to);               // ej: 5493512602142
    const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: to549Digits,
      type: "text",
      text: { preview_url: false, body: text },
    };

    let r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = await r.json();

    // 2) si falla con 131030, reintenta con 54 + area + 15 + número
    if (!r.ok && data?.error?.code === 131030) {
      const to5415Digits = to5415(to);           // ej: 54351152602142
      const payloadAlt = { ...payload, to: to5415Digits };
      r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payloadAlt),
      });
      data = await r.json();
    }

    if (!r.ok) {
      console.error("WA send error:", JSON.stringify(data));
      return res.status(400).json({ error: data });
    }

    // Persistimos mensaje saliente
    const convId = conversationId || `+${to549Digits}`; // guarda en +549...
    const convRef = db.collection("conversations").doc(convId);
    await convRef.set(
      { contactId: convId, lastMessageAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    const waMessageId = data?.messages?.[0]?.id || `out_${Date.now()}`;
    await convRef.collection("messages").doc(waMessageId).set({
      direction: "out",
      type: "text",
      text,
      timestamp: new Date(),
      status: "sent",
      to: `+${to549Digits}`,
      raw: data,
    });

    return res.status(200).json({ ok: true, id: waMessageId, to: `+${to549Digits}` });
  } catch (e) {
    console.error("sendMessage error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
