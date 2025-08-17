// crm-backend/api/waWebhook.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Verificación del webhook (Meta → "hub.challenge")
    const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages || [];

      for (const m of messages) {
        const from = m.from; // e.g. "5491123456789"
        const phoneE164 = `+${from}`;
        const text = m.text?.body ?? "";
        const waMessageId = m.id;
        const timestamp = Number(m.timestamp || Date.now());

        // 1) Upsert contacto
        const contactRef = db.collection("contacts").doc(phoneE164);
        await contactRef.set(
          {
            phone: phoneE164,
            waId: from,
            updatedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // 2) Upsert conversación (1-1 por contacto)
        const convRef = db.collection("conversations").doc(phoneE164);
        await convRef.set(
          {
            contactId: phoneE164,
            lastMessageAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // 3) Guardar mensaje entrante
        const msgRef = convRef.collection("messages").doc(waMessageId);
        await msgRef.set({
          direction: "in",
          type: m.type || "text",
          text,
          timestamp: new Date(timestamp * 1000),
          raw: m,
        });
      }

      return res.status(200).send("OK");
    } catch (e) {
      console.error("waWebhook error:", e);
      return res.status(200).send("EVENT_RECEIVED"); // Meta solo requiere 200
    }
  }

  // CORS preflight u otros
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).send("");
  }

  return res.status(405).send("Method Not Allowed");
}
