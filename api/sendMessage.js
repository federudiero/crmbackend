// crm-backend/api/sendMessage.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v20.0"; // si falla, probá v19.0
const PHONE_ID = process.env.META_WA_PHONE_ID;
const TOKEN = process.env.META_WA_TOKEN;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const { to, text, conversationId } = body;

    if (!to || !text) {
      return res.status(400).json({ error: "to y text son requeridos" });
    }

    const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to, // E.164, ej: +54911xxxxxxx
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
      console.error("WA send error:", data);
      return res.status(400).json({ error: data });
    }

    // Persistimos mensaje saliente
    const convId = conversationId || to;
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
      raw: data,
    });

    return res.status(200).json({ ok: true, id: waMessageId });
  } catch (e) {
    console.error("sendMessage error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
