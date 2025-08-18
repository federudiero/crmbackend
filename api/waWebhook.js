// api/waWebhook.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

/**
 * Configuración mínima:
 * - META_WA_VERIFY_TOKEN en env para la verificación GET
 * - (Opcional) AGENTS_CSV="agent1,agent2,agent3,agent4" para asignación
 */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getAgents() {
  const raw = process.env.AGENTS_CSV || "";
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  // Fallback si no hay env (ajústalo a tus 4–5 agentes reales)
  return list.length ? list : ["agent1", "agent2", "agent3", "agent4"];
}

function pickAgent(agents) {
  // Round-robin temporal, simple y determinista por minuto
  return agents[Math.floor(Date.now() / 60000) % agents.length];
}

function safeParseBody(req) {
  try {
    return typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
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

  // Verificación (GET)
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

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  // Solo POST soportado para eventos
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = safeParseBody(req);
    // === Debug opcional del raw (comenta estas 3 líneas si no quieres guardar todo) ===
    await db.collection("wa_incoming_raw").add({ at: new Date(), body });
    // ================================================================================

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      // Meta solo necesita 200 para no reintentar
      return res.status(200).send("EVENT_RECEIVED");
    }

    const agents = getAgents();

    // 1) MENSAJES ENTRANTES
    const messages = value.messages || [];
    for (const m of messages) {
      const from = m.from;                 // ej: "5493518120950" o "5435115...."
      const phoneE164 = `+${from}`;
      const waMessageId = m.id;
      // Meta envía m.timestamp en segundos (string)
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text = extractTextFromMessage(m);

      // -------- Contacto (sin pisar createdAt)
      const contactRef = db.collection("contacts").doc(phoneE164);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: phoneE164,
        waId: from,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // -------- Conversación 1-1 (sin pisar createdAt)
      const convRef = db.collection("conversations").doc(phoneE164);
      const convSnap = await convRef.get();
      const baseConv = {
        contactId: phoneE164,
        lastMessageAt: FieldValue.serverTimestamp(),
      };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      // -------- Asignación de ownerId si no tiene
      const existingOwner = convSnap.exists ? convSnap.data()?.ownerId : undefined;
      if (!existingOwner) {
        await convRef.set({ ownerId: pickAgent(agents) }, { merge: true });
      }

      // -------- Persistir mensaje
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

    // 2) ESTADOS (sent, delivered, read, failed)
    const statuses = value.statuses || [];
    for (const s of statuses) {
      // s.recipient_id es el wa_id del destinatario, formateamos igual que conversations (+<wa_id>)
      const convRefStatus = db.collection("conversations").doc(`+${s.recipient_id}`);
      await convRefStatus.collection("messages").doc(s.id).set(
        {
          status: s.status,                      // sent, delivered, read, failed
          statusTimestamp: new Date(),
          rawStatus: s,
        },
        { merge: true }
      );
    }

    // Responder siempre 200
    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    // Importante: responder 200 para que Meta no reintente en loop
    return res.status(200).send("EVENT_RECEIVED");
  }
}
