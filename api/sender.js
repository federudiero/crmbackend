// Devuelve el Phone ID (y env var) que usará el vendedor logueado.
import { getFirestore } from "firebase-admin/firestore";
import admin from "../lib/firebaseAdmin.js";

const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
  "escalantefr.p@gmail.com": "META_WA_PHONE_ID_VM"
};

export default async function handler(req, res) {
  try {
    const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const auth = req.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded; 
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch { return res.status(401).json({ error: "Invalid token" }); }

    const db = getFirestore();
    const uid = decoded.uid;
    const email = (decoded.email || "").toLowerCase();

    let phoneEnvKey = null;
    try {
      const doc = await db.collection("sellers").doc(uid).get();
      if (doc.exists) phoneEnvKey = doc.data()?.phoneEnvKey || null;
    } catch {}

    if (!phoneEnvKey && email) phoneEnvKey = EMAIL_TO_ENV[email] || "META_WA_PHONE_ID";

    const PHONE_ID = (phoneEnvKey && process.env[phoneEnvKey]) || process.env.META_WA_PHONE_ID;
    if (!PHONE_ID) return res.status(404).json({ error: "Phone ID not found for seller" });

    return res.status(200).json({ phoneEnvKey, phoneId: PHONE_ID, seller: { uid, email } });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
