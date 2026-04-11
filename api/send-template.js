// api/send-template.js
// Envía plantillas WhatsApp + guarda OUT en Firestore con convId canónico (+549...)
// - CORS allowlist dinámica
// - Acepta payload viejo/nuevo (front viejo: { phone, components } / nuevo: { to, template: {...} })
// - Envía EXACTA cantidad de variables por template
// - Guarda preview útil + texto resuelto completo
// - Opt-in: por defecto permite legacy (marketingOptIn undefined) si optIn=true
//   Si querés modo estricto: REQUIRE_MARKETING_OPTIN=1 => exige marketingOptIn===true

import admin from "../lib/firebaseAdmin.js";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  buildContactDocIds,
  buildScopedConversationId,
  digits,
  normalizeE164AR,
  resolveConversationContext,
} from "../lib/conversationScope.js";

// ====== Config ======
const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";

// Si REQUIRE_MARKETING_OPTIN=1 => exige marketingOptIn===true
// Si REQUIRE_MARKETING_OPTIN=0 => permite legacy (marketingOptIn undefined) mientras optIn===true (bloquea solo si marketingOptIn===false)
const REQUIRE_MARKETING_OPTIN = String(process.env.REQUIRE_MARKETING_OPTIN || "0") === "1";

// templates permitidas (allowlist)
const ALLOWED_TEMPLATES = new Set(["promo_hogarcril_combos", "reengage_free_text"]);
const DEFAULT_TEMPLATE = "promo_hogarcril_combos";

// Cantidad esperada de variables por template
const TEMPLATE_PARAM_COUNT = {
  promo_hogarcril_combos: 6,
  reengage_free_text: 1,
};

// Resolver phone id por seller
const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
  "escalantefr.p@gmail.com": "META_WA_PHONE_ID_VM",
  "laurialvarez456@gmail.com": "META_WA_PHONE_ID_1002",
};

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

// ====== helpers números (AR) ======
function candidatesForSendAR(toRaw) {
  const d0 = digits(toRaw);

  if (/^549\d+$/.test(d0)) {
    const areaLocal = d0.slice(3);
    const m = areaLocal.match(/^(\d{2,4})(\d+)$/);
    if (!m) return [d0];
    const [, area, rest] = m;
    return PREFER_5415 ? [`54${area}15${rest}`, d0] : [d0, `54${area}15${rest}`];
  }

  const m5415 = d0.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, rest] = m5415;
    return PREFER_5415 ? [d0, `549${area}${rest}`] : [`549${area}${rest}`, d0];
  }

  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");

  const area = /^11\d{8}$/.test(d) ? d.slice(0, 2) : d.slice(0, 3);
  const local = d.slice(area.length);

  const v549 = `549${area}${local}`;
  const v5415 = `54${area}15${local}`;
  return PREFER_5415 ? [v5415, v549] : [v549, v5415];
}

// ====== sanitize ======
function sanitizeDisplayText(input) {
  if (input === "\u200B") return input; // ZWSP permitido

  let x = String(input ?? "");
  x = x.replace(/\r\n?/g, "\n");
  x = x.replace(/\t+/g, " ");
  x = x.replace(/\n{3,}/g, "\n\n");

  x = x
    .split("\n")
    .map((line) => {
      let y = line;
      y = y.replace(/[\f\v]+/g, " ");
      y = y.replace(/ {5,}/g, "    ");
      y = y.replace(/ {2,}/g, " ");
      return y.trim();
    })
    .join("\n")
    .trim();

  const MAX = 1000;
  if (x.length > MAX) x = x.slice(0, MAX - 1) + "…";
  return x;
}

function sanitizeParamForMeta(input) {
  if (input === "\u200B") return input; // ZWSP permitido

  let x = String(input ?? "");
  x = x.replace(/\r\n?/g, "\n");
  x = x.replace(/\t+/g, " ");
  x = x.replace(/\n+/g, " "); // Meta NO acepta saltos dentro del parámetro
  x = x.replace(/ {5,}/g, "    "); // máximo 4 espacios seguidos
  x = x.replace(/ {2,}/g, " ");
  x = x.trim();

  const MAX = 1000;
  if (x.length > MAX) x = x.slice(0, MAX - 1) + "…";
  return x;
}

function stripZWSP(s) {
  const x = String(s ?? "");
  return x === "\u200B" ? "" : x;
}

function fallbackKeysForIndex(idx) {
  switch (idx) {
    case 0:
      return ["v1", "var1", "body1", "saludo", "nombre", "cliente", "name1"];
    case 1:
      return ["v2", "var2", "body2", "vendedor", "seller", "vendedora", "name2"];
    case 2:
      return ["v3", "var3", "body3", "promo1", "promo_1", "combo1", "combo_1", "item1", "name3"];
    case 3:
      return ["v4", "var4", "body4", "promo2", "promo_2", "combo2", "combo_2", "item2", "name4"];
    case 4:
      return ["v5", "var5", "body5", "promo3", "promo_3", "combo3", "combo_3", "item3", "name5"];
    case 5:
      return ["v6", "var6", "body6", "promo4", "promo_4", "combo4", "combo_4", "item4", "name6"];
    default:
      return [`v${idx + 1}`, `var${idx + 1}`, `body${idx + 1}`, `name${idx + 1}`];
  }
}

function buildResolvedTextFromVars(tName, vars) {
  const v1 = stripZWSP(vars?.[0]); // cliente
  const v2 = stripZWSP(vars?.[1]); // vendedora
  const extras = (vars || []).slice(2).map(stripZWSP).filter(Boolean);
  const brandName = String(process.env.VITE_BRAND_NAME || "HogarCril").trim();

  if (tName === "reengage_free_text") {
    const freeText = extras[0] || "";

    if (freeText && freeText.toLowerCase() !== brandName.toLowerCase()) {
      return freeText.trim();
    }

    const hello = v1 ? `Hola ${v1}` : "Hola";
    const sellerPart = v2 ? `, soy ${v2}` : "";
    const brandPart = brandName ? ` de ${brandName}` : "";
    return `${hello}${sellerPart}${brandPart}.`.trim();
  }

  if (tName === "promo_hogarcril_combos") {
    let header = "";

    if (v1 && v2) {
      header = `Hola ${v1}, soy ${v2} de Hogar Cril. Hoy tenemos estas promos:`;
    } else if (v1) {
      header = `Hola ${v1}. Hoy tenemos estas promos:`;
    } else if (v2) {
      header = `Hola, soy ${v2} de Hogar Cril. Hoy tenemos estas promos:`;
    } else {
      header = "Hoy tenemos estas promos:";
    }

    let out = header;
    if (extras.length) out += `\n\n${extras.join("\n")}`;
    out += "\n\n¿Querés que te reserve alguno?";

    return out.trim();
  }

  return `[Plantilla ${tName}]`;
}

function previewFromVars(tName, vars) {
  const full = buildResolvedTextFromVars(tName, vars);

  const MAX = 220;
  const compact = full
    .replace(/\n+/g, " • ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return compact.length > MAX ? compact.slice(0, MAX - 1) + "…" : compact;
}

// ====== CORS (allowlist dinámica) ======
function setCors(req, res) {
  const raw = String(
    process.env.ALLOWED_ORIGIN ||
      "https://crmhogarcril.com,http://localhost:5173,http://localhost:5174"
  );

  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || "";

  if (allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ====== leer body JSON (compat Vercel/Node) ======
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

async function getUserWaPhoneId(db, uid) {
  try {
    const userDoc = await db.collection("users").doc(String(uid || "")).get();
    if (!userDoc.exists) return "";
    return String(userDoc.data()?.waPhoneId || "").trim();
  } catch (e) {
    console.error("[send-template] users/{uid}.waPhoneId lookup failed:", e?.message || e);
    return "";
  }
}

async function resolveGeneralPhoneId(db, uid, email) {
  let phoneEnvKey = null;

  try {
    const docSnap = await db.collection("sellers").doc(String(uid || "")).get();
    if (docSnap.exists) {
      phoneEnvKey = String(docSnap.data()?.phoneEnvKey || "").trim() || null;
    }
  } catch (e) {
    console.error("[send-template] sellers/{uid} lookup failed:", e?.message || e);
  }

  if (!phoneEnvKey && email) {
    phoneEnvKey = EMAIL_TO_ENV[email] || null;
  }

  if (phoneEnvKey && process.env[phoneEnvKey]) {
    return {
      phoneId: process.env[phoneEnvKey],
      phoneEnvKey,
      phoneSource: "seller-env",
    };
  }

  const waPhoneId = await getUserWaPhoneId(db, uid);
  if (waPhoneId) {
    return {
      phoneId: waPhoneId,
      phoneEnvKey: null,
      phoneSource: "users.waPhoneId",
    };
  }

  const fallbackPhoneId =
    process.env.META_WA_PHONE_ID ||
    process.env.META_WA_PHONE_ID_0453 ||
    process.env.META_WA_PHONE_ID_8148 ||
    "";

  return {
    phoneId: fallbackPhoneId,
    phoneEnvKey,
    phoneSource: fallbackPhoneId ? "default-env" : "default-missing",
  };
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
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const db = getFirestore();
    const uid = decoded.uid;
    const email = (decoded.email || "").toLowerCase().trim();

    // ── Body (acepta payload viejo y nuevo)
    const input = await readJson(req);

    const toRaw =
      input?.to || input?.phone || input?.contactId || input?.contact || input?.number;

    if (!toRaw) return res.status(400).json({ error: "Missing phone/to" });

    // ── Resolver PHONE_ID + contexto de conversación
    let phoneEnvKey = null;
    let PHONE_ID = null;
    let phoneSource = null;

    const requestedConversationId = String(input?.conversationId || "").trim();
    const requestedPhoneId = String(input?.fromWaPhoneId || input?.phoneId || "").trim();

    const initialCtx = await resolveConversationContext(db, {
      conversationId: requestedConversationId,
      rawPhone: toRaw,
      phoneId: requestedPhoneId,
      preferScopedId: false,
    });

    if (requestedPhoneId) {
      PHONE_ID = requestedPhoneId;
      phoneSource = "explicit";
    }

    if (!PHONE_ID) {
      const inboundPhoneId = String(
        initialCtx?.data?.lastInboundPhoneId ||
          initialCtx?.data?.scopedPhoneNumberId ||
          initialCtx?.data?.businessPhoneId ||
          ""
      ).trim();

      if (inboundPhoneId) {
        PHONE_ID = inboundPhoneId;
        phoneSource = "conversation.phoneId";
      }
    }

    if (!PHONE_ID) {
      const resolvedPhone = await resolveGeneralPhoneId(db, uid, email);
      PHONE_ID = resolvedPhone.phoneId || null;
      phoneEnvKey = resolvedPhone.phoneEnvKey || null;
      phoneSource = resolvedPhone.phoneSource || null;
    }

    const resolvedCtx = await resolveConversationContext(db, {
      conversationId: requestedConversationId,
      rawPhone: toRaw,
      phoneId: PHONE_ID,
      preferScopedId: true,
    });

    const normalizedPhone = resolvedCtx?.normalizedPhone || normalizeE164AR(toRaw);

    const TOKEN = process.env.META_WA_TOKEN;

    if (!PHONE_ID || !TOKEN) {
      return res.status(500).json({
        error: `Missing PHONE_ID (${phoneEnvKey || "null"}) or META_WA_TOKEN`,
        seller: { uid, email },
        phoneSource,
      });
    }

    const tplObj = input?.template || null;

    const requested = String(
      input?.templateName || input?.name || tplObj?.name || DEFAULT_TEMPLATE
    ).trim();

    const tName = ALLOWED_TEMPLATES.has(requested) ? requested : DEFAULT_TEMPLATE;

    // language puede venir como string ("es_AR") o como { code: "es_AR" }
    const lang = String(
      input?.languageCode || tplObj?.language?.code || tplObj?.language || "es_AR"
    );

    // components puede venir en input.components o en template.components
    const incomingComponents =
      Array.isArray(input?.components) && input.components.length
        ? input.components
        : Array.isArray(tplObj?.components) && tplObj.components.length
        ? tplObj.components
        : [];

    // ====== Normalizar components/body/params ======
    const norm = (incomingComponents || []).map((c) => ({
      type: String(c?.type || "body").toLowerCase(),
      parameters: (c?.parameters || []).map((p) => ({
        type: "text",
        text: sanitizeDisplayText(p?.text),
      })),
    }));

    const bodyComp = norm.find((c) => c.type === "body");
    const providedParams = bodyComp?.parameters || [];

    const expectedCount =
      TEMPLATE_PARAM_COUNT[tName] ?? Math.max(1, providedParams.length || 1);

    // ====== Fallback vars si no vienen components ======
    const pick = (...keys) => {
      for (const k of keys) {
        const v = typeof input?.[k] === "string" ? input[k] : null;
        if (v && v.trim() !== "") return v;
      }
      return null;
    };

    const vFallback = Array.from({ length: expectedCount }, (_, idx) => {
      const keys = fallbackKeysForIndex(idx);
      const value = pick(...keys);
      return sanitizeDisplayText(value ?? "\u200B");
    });

    // vars finales: una versión para CRM y otra para Meta
    const vars = [];
    const metaVars = [];

    for (let i = 0; i < expectedCount; i++) {
      const fromProvided = providedParams?.[i]?.text;
      const fromFallback = vFallback?.[i] ?? "\u200B";

      const displayValue = sanitizeDisplayText(fromProvided ?? fromFallback);
      const metaValue = sanitizeParamForMeta(displayValue);

      vars.push(displayValue);
      metaVars.push(metaValue);
    }

    const fixedComponents = [
      {
        type: "body",
        parameters: metaVars.map((x) => ({ type: "text", text: x })),
      },
    ];

    // ====== Seguridad / compliance: opt-in ======
    try {
      if (!normalizedPhone) {
        return res.status(400).json({ error: "Invalid phone (not AR canonical)" });
      }

      if (!resolvedCtx?.data) {
        return res.status(404).json({
          error: "Conversation not found for opt-in check",
          details: { conversationId: resolvedCtx?.conversationId || null, phone: normalizedPhone },
        });
      }

      const dataConv = resolvedCtx.data || {};
      const marketingOptInValue = dataConv.marketingOptIn;
      const optIn = dataConv.optIn === true;

      if (marketingOptInValue === false) {
        return res.status(403).json({
          error: "Contact opted-out of marketing (marketingOptIn=false)",
          details: {
            optIn,
            marketingOptIn: marketingOptInValue,
            REQUIRE_MARKETING_OPTIN,
            conversationId: resolvedCtx?.conversationId || null,
          },
        });
      }

      const allowed = REQUIRE_MARKETING_OPTIN
        ? marketingOptInValue === true
        : optIn === true;

      if (!allowed) {
        return res.status(403).json({
          error: "Contact is not opted-in for marketing messages",
          details: {
            optIn,
            marketingOptIn: marketingOptInValue,
            REQUIRE_MARKETING_OPTIN,
            conversationId: resolvedCtx?.conversationId || null,
          },
        });
      }
    } catch (e) {
      console.error("[send-template] opt-in check failed:", e);
      return res.status(500).json({ error: "Failed opt-in validation" });
    }

    // ====== Envío a Graph (probando 549/5415) ======
    const cands = candidatesForSendAR(normalizedPhone);

    let upstreamOk = false;
    let data = null;
    let usedToDigits = null;
    let lastErr = null;

    for (const cand of cands) {
      const payload = {
        messaging_product: "whatsapp",
        to: cand,
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
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const txt = await upstream.text();
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {
        data = { raw: txt };
      }

      if (upstream.ok) {
        upstreamOk = true;
        usedToDigits = cand;
        break;
      }

      lastErr = data;
      if (data?.error?.code !== 131030) break;
    }

    if (!upstreamOk) {
      console.error(
        "[WA TEMPLATE ERROR]",
        JSON.stringify({ toRaw, cands, template: tName, data: lastErr }, null, 2)
      );
      return res.status(400).json({ error: lastErr?.error || lastErr });
    }

    // ====== Guardar OUT en Firestore (convId scopeado por línea) ======
    let responseConversationId = resolvedCtx?.conversationId || null;
    try {
      const msgId = data?.messages?.[0]?.id || data?.message_id || null;

      const effectivePhone = normalizeE164AR(usedToDigits || normalizedPhone || toRaw);
      const convId = responseConversationId || buildScopedConversationId(effectivePhone, PHONE_ID);
      responseConversationId = convId;

      const resolvedText = buildResolvedTextFromVars(tName, vars);
      const textPreview = previewFromVars(tName, vars);

      const convRef = db.collection("conversations").doc(convId);
      const contactDocIds = buildContactDocIds({ conversationId: convId, normalizedPhone: effectivePhone });
      const baseContactData = {
        phone: effectivePhone,
        waId: digits(effectivePhone),
        conversationId: convId,
        scopedPhoneNumberId: PHONE_ID,
        updatedAt: FieldValue.serverTimestamp(),
      };
      for (const contactDocId of contactDocIds) {
        await db.collection("contacts").doc(contactDocId).set(baseContactData, { merge: true });
      }

      await convRef.set(
        {
          contactId: effectivePhone,
          clientPhone: effectivePhone,
          conversationId: convId,
          scopedPhoneNumberId: PHONE_ID,
          businessPhoneId: PHONE_ID,
          lastMessageAt: FieldValue.serverTimestamp(),
          lastMessageDirection: "out",
          lastMessageText: textPreview,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const messagesCol = convRef.collection("messages");
      const newId = msgId || messagesCol.doc().id;

      await messagesCol.doc(newId).set(
        {
          direction: "out",
          type: "template",
          template: {
            name: tName,
            language: lang,
            components: fixedComponents,
          },
          vars,
          metaVars,
          text: resolvedText,
          resolvedText,
          body: resolvedText,
          textPreview,
          businessPhoneId: PHONE_ID,
          timestamp: FieldValue.serverTimestamp(),
          status: "sent",
          sendVariant: usedToDigits?.startsWith("549") ? "549" : "5415",
          to: effectivePhone,
          toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
          rawResponse: data,
        },
        { merge: true }
      );
    } catch (e) {
      console.error("[OUT MSG SAVE] error:", e);
    }

    return res.status(200).json({
      ok: true,
      data,
      template: tName,
      conversationId: responseConversationId,
      from_phone_id: PHONE_ID,
      seller_uid: uid,
      seller_email: email,
      phoneEnvKey,
      phoneSource,
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("send-template fatal:", err);
    return res.status(status).json({ error: String(err?.message || err) });
  }
}