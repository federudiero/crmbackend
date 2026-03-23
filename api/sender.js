// api/sender.js
// Devuelve el Phone ID (y env var) que usará el vendedor logueado.

import { getFirestore } from "firebase-admin/firestore";
import admin from "../lib/firebaseAdmin.js";

const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
  "escalantefr.p@gmail.com": "META_WA_PHONE_ID_VM",
  "laurialvarez456@gmail.com": "META_WA_PHONE_ID_1002",
};

// Casillas individuales de Villa María
const PRIVATE_VM_USERS = {
  "escalantefr.p@gmail.com": {
    fallbackPhoneId: "721961900420098",
    fallbackEnvKey: "META_WA_PHONE_ID_VM",
    label: "Fernando Escalante",
  },
  "laurialvarez456@gmail.com": {
    fallbackPhoneId: "987669861103912",
    fallbackEnvKey: "META_WA_PHONE_ID_1002",
    label: "Laura Alvarez",
  },
};

export default async function handler(req, res) {
  try {
    const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const auth = req.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const db = getFirestore();
    const uid = String(decoded.uid || "");
    const email = String(decoded.email || "").trim().toLowerCase();

    let phoneEnvKey = null;
    let phoneId = null;
    let source = null;

    // --------------------------------------------------
    // 1) Villa María: primero resolver por users/{uid}.waPhoneId
    //    para que Fernando y Laura usen SIEMPRE su número propio.
    // --------------------------------------------------
    const privateVmCfg = PRIVATE_VM_USERS[email] || null;

    if (privateVmCfg) {
      try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (userDoc.exists) {
          const waPhoneId = String(userDoc.data()?.waPhoneId || "").trim();
          if (waPhoneId) {
            phoneId = waPhoneId;
            source = "users.waPhoneId";
          }
        }
      } catch (e) {
        console.error("[sender] users/{uid} lookup failed:", e?.message || e);
      }

      // fallback 1: env específica de Villa María
      if (!phoneId && privateVmCfg.fallbackEnvKey && process.env[privateVmCfg.fallbackEnvKey]) {
        phoneEnvKey = privateVmCfg.fallbackEnvKey;
        phoneId = process.env[privateVmCfg.fallbackEnvKey];
        source = "private-env-fallback";
      }

      // fallback 2: hardcode del phoneId real
      if (!phoneId && privateVmCfg.fallbackPhoneId) {
        phoneEnvKey = privateVmCfg.fallbackEnvKey || null;
        phoneId = privateVmCfg.fallbackPhoneId;
        source = "private-hardcoded-fallback";
      }
    }

    // --------------------------------------------------
    // 2) Córdoba / resto: mantener lógica actual
    // --------------------------------------------------
    if (!phoneId) {
      try {
        const sellerDoc = await db.collection("sellers").doc(uid).get();
        if (sellerDoc.exists) {
          phoneEnvKey = sellerDoc.data()?.phoneEnvKey || null;
        }
      } catch (e) {
        console.error("[sender] sellers/{uid} lookup failed:", e?.message || e);
      }

      if (!phoneEnvKey && email) {
        phoneEnvKey = EMAIL_TO_ENV[email] || "META_WA_PHONE_ID";
      }

      phoneId =
        (phoneEnvKey && process.env[phoneEnvKey]) ||
        process.env.META_WA_PHONE_ID ||
        null;

      if (phoneId && !source) {
        source = phoneEnvKey ? "seller-env" : "default-env";
      }
    }

    // --------------------------------------------------
    // 3) Último fallback: users/{uid}.waPhoneId para cualquier otro caso
    // --------------------------------------------------
    if (!phoneId) {
      try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (userDoc.exists) {
          const waPhoneId = String(userDoc.data()?.waPhoneId || "").trim();
          if (waPhoneId) {
            phoneId = waPhoneId;
            source = "users.waPhoneId-fallback";
          }
        }
      } catch (e) {
        console.error("[sender] final users/{uid} fallback failed:", e?.message || e);
      }
    }

    if (!phoneId) {
      return res.status(404).json({
        error: "Phone ID not found for seller",
        seller: { uid, email },
      });
    }

    return res.status(200).json({
      phoneEnvKey,
      phoneId,
      source,
      seller: { uid, email },
    });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err),
    });
  }
}