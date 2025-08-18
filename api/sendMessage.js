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

const digits = (s) => String(s || "").replace(/\D/g, "");

/**
 * Genera candidatos para Argentina:
 *  A) 549 + area + numero                  (celular E.164)
 *  B) 54 + area + 15 + numero              (formato sandbox que a veces guarda Meta)
 * También respeta si ya viene 54... tal cual y genera el alternativo.
 */
function candidatesAR(toRaw) {
  const d0 = digits(toRaw);

  // Si ya viene con 54... usamos eso como primario y construimos el alternativo
  if (d0.startsWith("54")) {
    const out = [d0];
    // alternar 549 <-> 54 + 15
    if (/^549(\d{3})(\d+)$/.test(d0)) {
      const [, area, rest] = d0.match(/^549(\d{3})(\d+)$/);
      out.push(`54${area}15${rest}`);
    } else if (/^54(\d{3})15(\d+)$/.test(d0)) {
      const [, area, rest] = d0.match(/^54(\d{3})15(\d+)$/);
      out.push(`549${area}${rest}`);
    }
    return Array.from(new Set(out));
  }

  // Caso local: 0? area (2-4) + numero
  let d = d0;
  if (d.startsWith("00")) d = d.slice(2); // 00 internacional
  if (d.startsWith("0"))  d = d.slice(1); // 0 de área

  // Heurística simple para área
  let areaLen = 3;
  if (/^11\d{8}$/.test(d)) areaLen = 2; // CABA
  const area = d.slice(0, areaLen);
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
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({ error: "server_misconfigured" });
    }

    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    let   { to, text, template } = body;

    // Validaciones
    if (!to)   return res.status(400).json({ error: "missing_to" });
    if (!text && !template) return res.status(400).json({ error: "missing_text_or_template" });

    // Normalizamos a array para soportar 1..N destinatarios
    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const raw of recipients) {
      const cands = candidatesAR(raw);

      let delivered = null, usedTo = null, lastErr = null;
      for (const cand of cands) {
        const payload = template
          ? { type: "template", template } // { name, language: { code }, components? }
          : { type: "text", text: { body: typeof text === "string" ? text : text?.body, preview_url: false } };

        const r = await sendToGraph(cand, payload);
        if (r.ok) { delivered = r.json; usedTo = cand; break; }

        const code = r?.json?.error?.code;
        lastErr = r.json;
        // 131030 = "Unsupported number format / not allowed" → probamos el alternativo
        if (code !== 131030) break;
      }

      if (delivered) {
        // Conversación SIEMPRE = número realmente usado para enviar
        const convId = `+${usedTo}`;
        const convRef = db.collection("conversations").doc(convId);

        await convRef.set(
          { contactId: convId, lastMessageAt: FieldValue.serverTimestamp() },
          { merge: true }
        );

        const wamid = delivered?.messages?.[0]?.id || `out_${Date.now()}`;

        await convRef.collection("messages").doc(wamid).set({
          direction: "out",
          type: template ? "template" : "text",
          text: template ? undefined : (typeof text === "string" ? text : text?.body),
          template: template?.name ?? undefined,
          timestamp: FieldValue.serverTimestamp(),
          status: "accepted",
          to: convId,
          raw: delivered,
        });

        results.push({ to: convId, ok: true, id: wamid });
      } else {
        results.push({ to: raw, ok: false, error: lastErr || { message: "send_failed" } });
      }
    }

    return res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}
