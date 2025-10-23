// Envía SIEMPRE la plantilla promo_hogarcril_combos (es_AR).
// Selecciona el PHONE_ID según el email del vendedor (Firebase Auth).
import { getFirestore } from "firebase-admin/firestore";
import admin from "../lib/firebaseAdmin.js";

const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
};

export default async function handler(req, res) {
  try {
    const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Auth: Firebase ID token
    const auth = req.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded; 
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch { return res.status(401).json({ error: "Invalid token" }); }

    // Resolver PHONE_ID (doc sellers/{uid} o por email)
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

    // Body
    const payloadIn = await readJson(req);
    const { phone, components = [] } = payloadIn || {};
    if (!phone) return res.status(400).json({ error: "Missing phone" });

    // Payload bloqueado
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: "promo_hogarcril_combos",
        language: { code: "es_AR" },
        components,
      },
    };

    // Envío
    const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const txt = await r.text(); 
    let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) return res.status(r.status).json({ error: data?.error || data });

    return res.status(200).json({ ok: true, data, from_phone_id: PHONE_ID, seller_uid: uid, seller_email: email, phoneEnvKey });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

async function readJson(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
