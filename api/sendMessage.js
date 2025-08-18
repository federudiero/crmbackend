// api/sendMessage.js
import { db, FieldValue } from "../lib/firebaseAdmin.js";

const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const PHONE_ID = process.env.META_WA_PHONE_ID;
const TOKEN    = process.env.META_WA_TOKEN;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Helpers comunes ---
const digits = (s) => String(s || "").replace(/\D/g, "");

// Igual que en el webhook: canónica AR = +549AAAXXXXXXX
function normalizeE164AR(waIdOrPhone) {
  const d = digits(waIdOrPhone);

  // ya canónico
  if (d.startsWith("549")) return `+${d}`;

  // 54 + area(2-4) + 15 + local  ->  +549 + area + local
  const m = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m) {
    const [, area, local] = m;
    return `+549${area}${local}`;
  }

  // por si viene +54… sin 15
  if (d.startsWith("54")) return `+${d}`;

  // otros países: sólo agrego +
  return `+${d}`;
}

// Genera candidatos para AR y prioriza SIEMPRE 549... primero
function candidatesAR(toRaw) {
  const d0 = digits(toRaw);

  // Si ya empieza con 54..., reordenamos para que 549 vaya primero
  if (d0.startsWith("54")) {
    const m15 = d0.match(/^54(\d{2,4})15(\d+)$/);
    const m49 = d0.match(/^549(\d{2,4})(\d+)$/);
    if (m15) {
      const [, area, rest] = m15;
      return [`549${area}${rest}`, `54${area}15${rest}`];
    }
    if (m49) {
      const [, area, rest] = m49;
      return [`549${area}${rest}`, `54${area}15${rest}`];
    }
    // Otro caso raro: lo dejamos tal cual
    return [d0];
  }

  // Entrada sin 54/549 (ej "3518120950" o "0351...")
  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0"))  d = d.slice(1);

  // área 2 dígitos para CABA (11), 3 para el resto (simplificado)
  let areaLen = 3;
  if (/^11\d{8}$/.test(d)) areaLen = 2;
  const area  = d.slice(0, areaLen);
  const local = d.slice(areaLen);

  const cand549  = `549${area}${local}`;
  const cand5415 = `54${area}${local.startsWith("15") ? local : `15${local}`}`;
  return [cand549, cand5415];
}

async function sendToGraph(to, payload) {
  const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

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
      const cands = candidatesAR(raw);

      let delivered = null, usedTo = null, lastErr = null;

      // Intentamos en orden, pero sólo registramos usando el ID CANÓNICO
      for (const cand of cands) {
        const payload = template
          ? { type: "template", template }
          : { type: "text", text: { body: typeof text === "string" ? text : text?.body, preview_url: false } };

        const r = await sendToGraph(cand, payload);
        console.log("WA send", { cand, ok: r.ok, status: r.status, json: r.json });

        if (r.ok) { delivered = r.json; usedTo = cand; break; }

        const code = r?.json?.error?.code;
        lastErr = r.json;
        if (code !== 131030) break; // si no es “formato no permitido”, no sigas
      }

      // 🔒 Conversación SIEMPRE bajo convId canónico (igual que el webhook)
      const convId  = normalizeE164AR(usedTo || cands[0]); // ej. "+5493518120950"
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
        to: convId,                    // ✅ almacenado canónico
        toRaw: usedTo || cands[0],     // opcional: para depurar lo enviado a Graph
        status: delivered ? "sent" : "error",
        raw: delivered || undefined,
        error: delivered ? undefined : (lastErr || { message: "send_failed" }),
      };

      if (!template) msgDoc.text = typeof text === "string" ? text : text?.body || "";
      else           msgDoc.template = template?.name || null;

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);

      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      // Le devolvemos al front el ID correcto del hilo para que navegue ahí
      results.push({ to: convId, ok: !!delivered, id: wamid, error: msgDoc.error });
    }

    return res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
