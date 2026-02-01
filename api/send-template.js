// api/send-template.js
// Envía plantillas WhatsApp (promo / remarketing) + guarda OUT en Firestore con convId canónico (+549...)
// FIX: normaliza convId (AR 5415 -> 549) para que el CRM siempre vea los salientes
import { getFirestore } from "firebase-admin/firestore";
import admin from "../lib/firebaseAdmin.js";

// ====== Config ======
const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";

// templates permitidas
const ALLOWED_TEMPLATES = new Set([
  "promo_hogarcril_combos",
  "reengage_free_text",
]);

const DEFAULT_TEMPLATE = "promo_hogarcril_combos";

const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
};

// ====== helpers números (AR) ======
const digits = (s) => String(s || "").replace(/\D+/g, "");

function normalizeE164AR(raw) {
  let d = digits(raw);
  if (!d) return "";
  if (d.startsWith("549")) return `+${d}`;
  const m5415 = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, local] = m5415;
    return `+549${area}${local}`;
  }
  if (d.startsWith("54")) return `+${d}`;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  return `+${d}`;
}

function candidatesForSendAR(toRaw) {
  const d0 = digits(toRaw);

  // Si ya viene 549..., probamos 549 y 5415
  if (/^549\d+$/.test(d0)) {
    const areaLocal = d0.slice(3);
    const m = areaLocal.match(/^(\d{2,4})(\d+)$/);
    if (!m) return [d0];
    const [, area, rest] = m;
    return PREFER_5415 ? [`54${area}15${rest}`, d0] : [d0, `54${area}15${rest}`];
  }

  // Si viene 5415..., probamos 549 y 5415
  const m5415 = d0.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, rest] = m5415;
    return PREFER_5415 ? [d0, `549${area}${rest}`] : [`549${area}${rest}`, d0];
  }

  // Fallback genérico: armar 549 y 5415 desde lo que haya
  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  const area = /^11\d{8}$/.test(d) ? d.slice(0, 2) : d.slice(0, 3);
  const local = d.slice(area.length);
  const v549 = `549${area}${local}`;
  const v5415 = `54${area}15${local}`;
  return PREFER_5415 ? [v5415, v549] : [v549, v5415];
}

// ====== sanitize (Meta) ======
function sanitizeParamServer(input) {
  if (input === "\u200B") return input; // ZWSP permitido
  let x = String(input ?? "");

  x = x.replace(/[\r\t]+/g, " ");
  x = x.replace(/\n+/g, " • ");
  x = x.replace(/\s{2,}/g, " ");
  x = x.replace(/ {5,}/g, "    ");
  x = x.trim();

  const MAX_PARAM_LEN = 1000;
  if (x.length > MAX_PARAM_LEN) x = x.slice(0, MAX_PARAM_LEN - 1) + "…";
  return x;
}

// ====== cors ======
function setCors(req, res) {
  const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

// ====== main ======
export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // ── Auth Firebase
    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch { return res.status(401).json({ error: "Invalid token" }); }

    const db = getFirestore();
    const uid = decoded.uid;
    const email = (decoded.email || "").toLowerCase();

    // ── Resolver PHONE_ID por seller
    let phoneEnvKey = null;
    try {
      const doc = await db.collection("sellers").doc(uid).get();
      if (doc.exists) phoneEnvKey = doc.data()?.phoneEnvKey || null;
    } catch { }

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

    const {
      phone,
      components = [],
      templateName,
      name, // alias opcional
      languageCode,
    } = input || {};

    if (!phone) return res.status(400).json({ error: "Missing phone" });

    // template a enviar
    const requested = String(templateName || name || DEFAULT_TEMPLATE).trim();
    const tName = ALLOWED_TEMPLATES.has(requested) ? requested : DEFAULT_TEMPLATE;

    const lang = String(languageCode || "es_AR");

    // ====== Fallback robusto para evitar #132018 ======
    const pick = (...keys) => {
      for (const k of keys) {
        const v = typeof input?.[k] === "string" ? input[k] : null;
        if (v && v.trim() !== "") return v;
      }
      return null;
    };

    const v1 = sanitizeParamServer(pick("v1", "var1", "body1", "saludo", "nombre", "name1") || "\u200B");
    const v2 = sanitizeParamServer(pick("v2", "var2", "body2", "vendedor", "seller", "name2") || "\u200B");
    const v3 = sanitizeParamServer(pick("v3", "var3", "body3", "promos", "texto", "lista", "body", "name3") || "\u200B");

    let fixedComponents;
    if (Array.isArray(components) && components.length) {
      const norm = (components || []).map((c) => ({
        type: String(c?.type || "body").toLowerCase(),
        parameters: (c?.parameters || []).map((p) => ({
          type: "text",
          text: sanitizeParamServer(p?.text),
        })),
      }));
      const bodyComp = norm.find(c => c.type === "body");
      const params = (bodyComp?.parameters || []);
      const p0 = params[0]?.text ?? v1;
      const p1 = params[1]?.text ?? v2;
      const p2 = params[2]?.text ?? v3;

      fixedComponents = [{
        type: "body",
        parameters: [
          { type: "text", text: sanitizeParamServer(p0) },
          { type: "text", text: sanitizeParamServer(p1) },
          { type: "text", text: sanitizeParamServer(p2) },
        ]
      }];
    } else {
      fixedComponents = [{
        type: "body",
        parameters: [
          { type: "text", text: v1 },
          { type: "text", text: v2 },
          { type: "text", text: v3 },
        ],
      }];
    }

    // ====== Envío a Graph (probando 549/5415) ======
    const cands = candidatesForSendAR(phone);

    let upstreamOk = false;
    let data = null;
    let usedToDigits = null;
    let lastErr = null;

    for (const cand of cands) {
      const payload = {
        messaging_product: "whatsapp",
        to: cand, // dígitos sin '+'
        type: "template",
        template: {
          name: tName,
          language: { code: lang },
          components: fixedComponents,
        },
      };

      const url = `${GRAPH_BASE}/${PHONE_ID}/messages`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const txt = await upstream.text();
      try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }

      if (upstream.ok) {
        upstreamOk = true;
        usedToDigits = cand;
        break;
      }

      lastErr = data;
      // allow-list sandbox: 131030 (si lo tenés) => intentamos el otro candidato
      if (data?.error?.code !== 131030) break;
    }

    if (!upstreamOk) {
      console.error("[WA TEMPLATE ERROR]", JSON.stringify({ phone, cands, template: tName, data: lastErr }, null, 2));
      return res.status(400).json({ error: lastErr?.error || lastErr });
    }

    // ====== Guardar OUT en Firestore en convId canónico ======
    try {
      const msgId = data?.messages?.[0]?.id || data?.message_id || null;

      // FIX CLAVE: convId canónico +549...
      const convId = normalizeE164AR(usedToDigits || phone);

      const bodyComp = fixedComponents.find(c => c.type === "body");
      const ps = bodyComp?.parameters || [];
      const p1 = ps[0]?.text || "";
      const p2 = ps[1]?.text || "";
      const textPreview =
        (p1 && p2) ? `Hola ${p1}, soy ${p2}.` :
          (p2 ? `Soy ${p2}.` : `[Plantilla ${tName}]`);

      const convRef = db.collection("conversations").doc(convId);

      await convRef.set({
        contactId: convId,
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageDirection: "out",
        lastMessageText: textPreview,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await convRef.collection("messages")
        .doc(msgId || db.collection("_").doc().id)
        .set({
          direction: "out",
          type: "template",
          template: {
            name: tName,
            language: lang,
            components: fixedComponents,
          },
          textPreview,
          businessPhoneId: PHONE_ID,          // ✅ mismo nombre que el resto del sistema
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "sent",
          sendVariant: usedToDigits?.startsWith("549") ? "549" : "5415",
          to: convId,
          toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
          rawResponse: data,
        }, { merge: true });
    } catch (e) {
      console.error("[OUT MSG SAVE] error:", e);
      // no rompemos la respuesta si el guardado falla
    }

    return res.status(200).json({
      ok: true,
      data,
      template: tName,
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
