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

async function getUserWaPhoneId(db, uid) {
  try {
    const userDoc = await db.collection("users").doc(String(uid || "")).get();
    if (!userDoc.exists) return "";
    return String(userDoc.data()?.waPhoneId || "").trim();
  } catch (e) {
    console.error("[sender] users/{uid}.waPhoneId lookup failed:", e?.message || e);
    return "";
  }
}

async function resolveGeneralPhoneId(db, uid, email) {
  let phoneEnvKey = null;

  try {
    const sellerDoc = await db.collection("sellers").doc(String(uid || "")).get();
    if (sellerDoc.exists) {
      phoneEnvKey = String(sellerDoc.data()?.phoneEnvKey || "").trim() || null;
    }
  } catch (e) {
    console.error("[sender] sellers/{uid} lookup failed:", e?.message || e);
  }

  if (!phoneEnvKey && email) {
    phoneEnvKey = EMAIL_TO_ENV[email] || null;
  }

  if (phoneEnvKey && process.env[phoneEnvKey]) {
    return {
      phoneId: process.env[phoneEnvKey],
      phoneEnvKey,
      source: "seller-env",
    };
  }

  const waPhoneId = await getUserWaPhoneId(db, uid);
  if (waPhoneId) {
    return {
      phoneId: waPhoneId,
      phoneEnvKey: null,
      source: "users.waPhoneId",
    };
  }

  const fallbackPhoneId = process.env.META_WA_PHONE_ID || null;
  return {
    phoneId: fallbackPhoneId,
    phoneEnvKey,
    source: fallbackPhoneId ? "default-env" : "default-missing",
  };
}

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

    const resolved = await resolveGeneralPhoneId(db, uid, email);
    const phoneEnvKey = resolved.phoneEnvKey || null;
    const phoneId = resolved.phoneId || null;
    const source = resolved.source || null;

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