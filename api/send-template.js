// api/send-template.js
// Envía SIEMPRE la plantilla promo_hogarcril_combos (es_AR) y normaliza components + número
import { getFirestore } from "firebase-admin/firestore";
import admin from "../lib/firebaseAdmin.js";

const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
};

// Limpia número a solo dígitos (Meta no quiere '+')
const digits = (s) => String(s || "").replace(/\D+/g, "");

// Sanea variables (preservando \n para que cada combo vaya en su propio renglón)
function sanitizeParamServer(input) {
  if (input === "\u200B") return input; // ZWSP permitido por Meta para “vacío”
  let x = String(input ?? "");

  // Antes: /[\r\n\t]+/g → " • "
  // Ahora: preservamos \n, pero limpiamos \r y \t
  x = x.replace(/[\r\t]+/g, " ");

  // Colapsamos saltos de línea excesivos (3+ → 2)
  x = x.replace(/\n{3,}/g, "\n\n");

  // Espacios múltiples
  x = x.replace(/\s{2,}/g, " ");
  x = x.replace(/ {5,}/g, "    ");

  x = x.trim();

  // Límite de seguridad de longitud por parámetro
  const MAX_PARAM_LEN = 1000;
  if (x.length > MAX_PARAM_LEN) x = x.slice(0, MAX_PARAM_LEN - 1) + "…";
  return x;
}

export default async function handler(req, res) {
  try {
    // ── CORS mínimo
    const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // ── Auth Firebase
    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch { return res.status(401).json({ error: "Invalid token" }); }

    // ── Resolver PHONE_ID por seller
    const db = getFirestore();
    const uid = decoded.uid;
    const email = (decoded.email || "").toLowerCase();

    let phoneEnvKey = null;
    try {
      const doc = await db.collection("sellers").doc(uid).get();
      if (doc.exists) phoneEnvKey = doc.data()?.phoneEnvKey || null;
    } catch {}

    if (!phoneEnvKey && email) phoneEnvKey = EMAIL_TO_ENV[email] || "META_WA_PHONE_ID";

    const PHONE_ID =
      (phoneEnvKey && process.env[phoneEnvKey]) ||
      process.env.META_WA_PHONE_ID ||
      process.env.META_WA_PHONE_ID_0453 ||
      process.env.META_WA_PHONE_ID_8148;

    const TOKEN = process.env.META_WA_TOKEN;
    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({ error: `Missing PHONE_ID (${phoneEnvKey}) or META_WA_TOKEN` });
    }

    // ── Body
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const input = raw ? JSON.parse(raw) : {};
    const { phone, components = [] } = input || {};
    if (!phone) return res.status(400).json({ error: "Missing phone" });

    // NORMALIZACIÓN DE COMPONENTES (evita #132018) + preserva \n en params
    const fixedComponents = (components || []).map((c) => ({
      type: String(c?.type || "body").toLowerCase(),
      parameters: (c?.parameters || []).map((p) => ({
        type: "text",
        text: sanitizeParamServer(p?.text),
      })),
    }));

    const payload = {
      messaging_product: "whatsapp",
      to: digits(phone), // ← sin '+'
      type: "template",
      template: {
        name: "promo_hogarcril_combos",
        language: { code: "es_AR" },
        components: fixedComponents,
      },
    };

    // ── Envío a Graph
    const url = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const txt = await upstream.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }

    if (!upstream.ok) {
      console.error("[WA ERROR]", JSON.stringify({ payload, data }, null, 2));
      return res.status(400).json({ error: data?.error || data });
    }

    // ─────────────────────────────────────────────────────────────
    // Guardar el mensaje saliente en Firestore para que el CRM lo vea
    // ─────────────────────────────────────────────────────────────
    try {
      const msgId = data?.messages?.[0]?.id || data?.message_id || null;

      // convId en E.164 con "+" (lo que usa tu UI)
      const onlyDigits = digits(phone);
      const convId = String(phone).startsWith("+") ? String(phone) : `+${onlyDigits}`;

      // preview cortita usando los parámetros de BODY ({{1}}, {{2}}, {{3}})
      const bodyComp = fixedComponents.find(c => c.type === "body");
      const ps = bodyComp?.parameters || [];
      const p1 = ps[0]?.text || ""; // saludo/nombre (puede venir vacío)
      const p2 = ps[1]?.text || ""; // vendedor
      // p3 = promos (texto largo). No lo metemos entero en preview para no alargar la lista
      const textPreview =
        (p1 && p2) ? `Hola ${p1}, soy ${p2}.` :
        (p2 ? `Soy ${p2}.` : "Plantilla enviada");

      // asegurar conversación y actualizar lastMessageAt
      await db.collection("conversations").doc(convId).set({
        contactId: convId,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // guardar mensaje
      await db.collection("conversations").doc(convId)
        .collection("messages")
        .doc(msgId || db.collection("_").doc().id)
        .set({
          direction: "out",
          type: "template",
          template: {
            name: "promo_hogarcril_combos",
            language: "es_AR",
            components: fixedComponents,
          },
          textPreview,
          fromPhoneId: PHONE_ID,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "sent",
          rawResponse: data, // útil para debug
        }, { merge: true });
    } catch (e) {
      console.error("[OUT MSG SAVE] error:", e);
      // no rompemos la respuesta al cliente si el guardado falla
    }
    // ─────────────────────────────────────────────────────────────

    return res.status(200).json({
      ok: true,
      data,
      from_phone_id: PHONE_ID,
      seller_uid: uid,
      seller_email: email,
      phoneEnvKey,
    });
  } catch (err) {
    console.error("send-template fatal:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
