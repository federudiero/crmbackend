// api/waWebhook.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

/**
 * Requisitos:
 * - META_WA_VERIFY_TOKEN (verificación GET)
 * - (Opcional) AGENTS_CSV="agent1,agent2,..." para asignación
 */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getAgents() {
  const raw = process.env.AGENTS_CSV || "";
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return list.length ? list : ["agent1", "agent2", "agent3", "agent4"];
}

function pickAgent(agents) {
  // round-robin simple por minuto
  return agents[Math.floor(Date.now() / 60000) % agents.length];
}

function safeParseBody(req) {
  try {
    return typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

// -------- Helpers de texto / tipos de mensajes
function extractTextFromMessage(m) {
  if (m.text?.body) return m.text.body;
  if (m.interactive?.nfm_reply?.body) return m.interactive.nfm_reply.body;
  if (m.interactive?.button_reply?.title) return m.interactive.button_reply.title;
  if (m.button?.text) return m.button.text;
  if (m.image?.caption) return m.image.caption;
  if (m.document?.caption) return m.document.caption;
  return "";
}

// -------- Normalización de números
const digits = (s) => String(s || "").replace(/\D/g, "");

// Convierte 54 + área + 15 + local  ->  +549 + área + local
// Deja igual otros países o 549 correcto.
function normalizeE164AR(waIdOrPhone) {
  const d = digits(waIdOrPhone);
  if (d.startsWith("549")) return `+${d}`;                        // ya correcto
  const m = d.match(/^54(\d{2,4})15(\d+)$/);                      // 54 + área + 15 + local
  if (m) {
    const [, area, rest] = m;
    return `+549${area}${rest}`;
  }
  if (d.startsWith("54")) return `+${d}`;                         // 54 + área + local (sin 15)
  return `+${d}`;                                                 // otros países / genérico
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
  if (req.method === "OPTIONS") return res.status(204).send("");

  // Solo POST soportado
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = safeParseBody(req);

    // (Opcional) log de crudo para debug
    await db.collection("wa_incoming_raw").add({ at: new Date(), body });

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) return res.status(200).send("EVENT_RECEIVED");

    const agents = getAgents();

    // 1) MENSAJES ENTRANTES
    for (const m of (value.messages || [])) {
      // ¡Normalizar SIEMPRE!
      const convId = normalizeE164AR(m.from);
      const waMessageId = m.id;
      const tsSec = Number(m.timestamp || Math.floor(Date.now() / 1000));
      const text = extractTextFromMessage(m);

      // ---- Contacto (no pisar createdAt)
      const contactRef = db.collection("contacts").doc(convId);
      const contactSnap = await contactRef.get();
      const contactData = {
        phone: convId,
        waId: digits(convId), // '549351…' (no recortes)
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!contactSnap.exists) contactData.createdAt = FieldValue.serverTimestamp();
      await contactRef.set(contactData, { merge: true });

      // ---- Conversación 1-1 (no pisar createdAt)
      const convRef = db.collection("conversations").doc(convId);
      const convSnap = await convRef.get();
      const baseConv = { contactId: convId, lastMessageAt: FieldValue.serverTimestamp() };
      if (!convSnap.exists) baseConv.createdAt = FieldValue.serverTimestamp();
      await convRef.set(baseConv, { merge: true });

      // ---- Asignación de ownerId si no tiene
      if (!convSnap.exists || !convSnap.data()?.ownerId) {
        await convRef.set({ ownerId: pickAgent(agents) }, { merge: true });
      }

      // ---- Persistir mensaje
      await convRef.collection("messages").doc(waMessageId).set({
        direction: "in",
        type: m.type || "text",
        text,
        timestamp: new Date(tsSec * 1000),
        raw: m,
      }, { merge: true });
    }

    // 2) ESTADOS (sent, delivered, read, failed)
    for (const s of (value.statuses || [])) {
      // ¡Normalizar también acá!
      const convId = normalizeE164AR(s.recipient_id);
      const convRefStatus = db.collection("conversations").doc(convId);
      await convRefStatus.collection("messages").doc(s.id).set({
        status: s.status,
        statusTimestamp: new Date(),
        rawStatus: s,
      }, { merge: true });
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("waWebhook error:", e);
    // Importante: devolver 200 para que Meta no reintente en loop
    return res.status(200).send("EVENT_RECEIVED");
  }
}
