// api/waWebhook.js — bandeja global sin auto-asignación
import { db, FieldValue } from "../lib/firebaseAdmin.js";

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
  return (
    m.text?.body ||
    m.interactive?.nfm_reply?.body ||
    m.interactive?.button_reply?.title ||
    m.button?.text ||
    m.image?.caption ||
    m.document?.caption ||
    ""
  );
}

export default async function handler(req, res) {
  cors(res);

  // GET de verificación (Meta)
  if (req.method === "GET") {
    const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = safeParseBody(req);
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const meta = value.metadata || {};
    const phoneId = meta.phone_number_id || null;
    const phoneDisplay = meta.display_phone_number || null;

    // ====== MENSAJES ENTRANTES ======
    for (const m of (value.messages || [])) {
      const convId = normalizeE164AR(m.from);
      const waMessageId = m.id;
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text  = extractTextFromMessage(m);

      // contacts
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: convId,
        waId: digits(convId).slice(1),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // conversations (⚠️ sin owner/asignación: bandeja global)
      const convRef = db.collection("conversations").doc(convId);
      const convSnap = await convRef.get();
      const baseConv = {
        contactId: convId,
        lastMessageAt: FieldValue.serverTimestamp(),
        lastInboundPhoneId: phoneId || null,
        lastInboundDisplay: phoneDisplay || null,
      };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      // message
      await convRef.collection("messages").doc(waMessageId).set(
        {
          direction: "in",
          type: m.type || "text",
          text,
          timestamp: new Date(tsSec * 1000),
          businessPhoneId: phoneId || null,
          businessDisplay: phoneDisplay || null,
          raw: m,
        },
        { merge: true }
      );
    }

    // ====== ESTADOS ======
    for (const s of (value.statuses || [])) {
      const convId = normalizeE164AR(s.recipient_id);
      await db
        .collection("conversations")
        .doc(convId)
        .collection("messages")
        .doc(s.id)
        .set(
          { status: s.status, statusTimestamp: new Date(), rawStatus: s },
          { merge: true }
        );
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    // WhatsApp reintenta si no devolvés 200 — respondemos 200 para cortar reintentos.
    return res.status(200).send("EVENT_RECEIVED");
  }
}
