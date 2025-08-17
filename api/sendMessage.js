// crm-backend/api/sendMessage.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const PHONE_ID = process.env.META_WA_PHONE_ID;
const TOKEN = process.env.META_WA_TOKEN;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Normaliza números de Argentina a E.164 ( +549AAAXXXXXXX )
function toE164AR(raw) {
  if (!raw) return null;
  // si ya viene con +, dejalo así (solo limpiamos espacios)
  if (String(raw).trim().startsWith("+")) {
    return String(raw).replace(/\s+/g, "");
  }
  // solo dígitos
  let s = String(raw).replace(/\D/g, "");

  // quitar prefijos internacionales 00
  if (s.startsWith("00")) s = s.slice(2);

  // quitar código de país si viene (54)
  if (s.startsWith("54")) s = s.slice(2);

  // quitar 0 inicial de área
  if (s.startsWith("0")) s = s.slice(1);

  // quitar "15" después del área (2 a 4 dígitos de área)
  s = s.replace(/^(\d{2,4})15/, "$1");

  // asegurar el 9 móvil
  if (!s.startsWith("9")) s = "9" + s;

  const e164 = "+54" + s;
  // validación mínima E.164 (8-15 dígitos después del +)
  if (!/^\+\d{8,15}$/.test(e164)) return null;
  return e164;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    cors(res);

    // Validar env vars
    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({
        error: "missing_env",
        detail: "META_WA_PHONE_ID o META_WA_TOKEN no configurados",
      });
    }

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const { to, text, conversationId } = body;

    if (!to || !text) {
      return res.status(400).json({ error: "to y text son requeridos" });
    }

    // Normalizar número (Argentina). Si ya viene con +E.164, solo limpia espacios.
    const toSanitized = toE164AR(to);
    if (!toSanitized) {
      return res.status(400).json({ error: "numero_invalido", detail: "Formato de número no válido. Usa E.164 (+549...)." });
    }

    const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: toSanitized, // E.164
      type: "text",
      text: { preview_url: false, body: text },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();

    if (!r.ok) {
      // Log para debug en Vercel (no imprime el token)
      console.error("WA send error:", JSON.stringify(data));
      return res.status(400).json({ error: data });
    }

    // Persistimos mensaje saliente en Firestore
    const convId = conversationId || toSanitized;
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
      to: toSanitized,
      raw: data,
    });

    return res.status(200).json({ ok: true, id: waMessageId, to: toSanitized });
  } catch (e) {
    console.error("sendMessage error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
