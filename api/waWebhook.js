// api/waWebhook.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

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

// ==== helpers de asignación (opcional) ====
function getAgents() {
  const raw = process.env.AGENTS_CSV || "";
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : ["agent1", "agent2", "agent3", "agent4"];
}
function pickAgent(agents) {
  return agents[Math.floor(Date.now() / 60000) % agents.length];
}

// ==== helpers de normalización AR ====
const digits = (s) => String(s || "").replace(/\D/g, "");

// Convierte "54 + area + 15 + local"  -> "+549 + area + local"
// Deja otros países tal cual, solo antepone "+"
function normalizeE164AR(waIdOrPhone) {
  const d = digits(waIdOrPhone);

  // ya canónico
  if (d.startsWith("549")) return `+${d}`;

  // 54 + area(2-4) + 15 + local
  const m = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m) {
    const [, area, local] = m;
    return `+549${area}${local}`;
  }

  // otros casos: +54… sin 15 (por si Meta algún día ya lo manda bien)
  if (d.startsWith("54")) return `+${d}`;

  // otros países
  return `+${d}`;
}

function extractTextFromMessage(m) {
  if (m.text?.body) return m.text.body;
  if (m.interactive?.nfm_reply?.body) return m.interactive.nfm_reply.body;
  if (m.interactive?.button_reply?.title) return m.interactive.button_reply.title;
  if (m.button?.text) return m.button.text;
  if (m.image?.caption) return m.image.caption;
  if (m.document?.caption) return m.document.caption;
  return "";
}

export default async function handler(req, res) {
  cors(res);

  // Verificación GET (Meta)
  if (req.method === "GET") {
    const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = safeParseBody(req);

    // DEBUG opcional — ver exactamente qué llega
    await db.collection("wa_incoming_raw").add({ at: new Date(), body });

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const agents = getAgents();

    // ====== 1) MENSAJES ENTRANTES ======
    for (const m of (value.messages || [])) {
      const fromRaw = m.from;                       // ej "54351158120950"
      const convId  = normalizeE164AR(fromRaw);     // ej "+5493518120950"
      const waMessageId = m.id;
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text  = extractTextFromMessage(m);

      // Log de depuración (te muestra si normalizó bien)
      await db.collection("wa_incoming_debug").add({
        at: new Date(),
        fromRaw,
        convId,
        messageId: waMessageId,
        type: m.type,
      });

      // -------- contacts
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: convId,
        waId: digits(convId).slice(1),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // -------- conversations
      const convRef = db.collection("conversations").doc(convId);
      const convSnap = await convRef.get();
      const baseConv = {
        contactId: convId,
        lastMessageAt: FieldValue.serverTimestamp(),
      };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      // -------- owner (solo si no tiene)
      const ownerId = convSnap.exists ? convSnap.data()?.ownerId : undefined;
      if (!ownerId) {
        await convRef.set({ ownerId: pickAgent(agents) }, { merge: true });
      }

      // -------- message (SIEMPRE bajo convId normalizado)
      await convRef.collection("messages").doc(waMessageId).set(
        {
          direction: "in",
          type: m.type || "text",
          text,
          timestamp: new Date(tsSec * 1000),
          raw: m,
        },
        { merge: true }
      );
    }

    // ====== 2) ESTADOS ======
    for (const s of (value.statuses || [])) {
      const convId = normalizeE164AR(s.recipient_id); // también normalizado
      const convRefStatus = db.collection("conversations").doc(convId);
      await convRefStatus.collection("messages").doc(s.id).set(
        {
          status: s.status,                // sent, delivered, read, failed
          statusTimestamp: new Date(),
          rawStatus: s,
        },
        { merge: true }
      );
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    // WhatsApp reintenta si no devolvés 200, por eso respondemos 200.
    return res.status(200).send("EVENT_RECEIVED");
  }
}
