// api/send-template.js
// Envía plantillas WhatsApp + guarda OUT en Firestore con convId canónico (+549...)
// - CORS allowlist dinámica
// - Acepta payload viejo/nuevo (front viejo: { phone, components } / nuevo: { to, template: {...} })
// - Envía EXACTA cantidad de variables por template
// - Guarda preview útil (incluye v3/promos)
// - Opt-in: por defecto permite legacy (marketingOptIn undefined) si optIn=true
//   Si querés modo estricto: REQUIRE_MARKETING_OPTIN=1 => exige marketingOptIn===true

import admin from "../lib/firebaseAdmin.js";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ====== Config ======
const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";

// Si REQUIRE_MARKETING_OPTIN=1 => exige marketingOptIn===true
// Si REQUIRE_MARKETING_OPTIN=0 => permite legacy (marketingOptIn undefined) mientras optIn===true (bloquea solo si marketingOptIn===false)
const REQUIRE_MARKETING_OPTIN = String(process.env.REQUIRE_MARKETING_OPTIN || "0") === "1";

// templates permitidas (allowlist)
const ALLOWED_TEMPLATES = new Set(["promo_hogarcril_combos", "reengage_free_text"]);
const DEFAULT_TEMPLATE = "promo_hogarcril_combos";

// Cantidad esperada de variables por template (evita mandar de más)
const TEMPLATE_PARAM_COUNT = {
  promo_hogarcril_combos: 3,
  reengage_free_text: 1,
};

// Resolver phone id por seller
const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
};

// ====== helpers números (AR) ======
const digits = (s) => String(s || "").replace(/\D+/g, "");

// Normaliza a E.164 AR canónico: +549{area}{local}
function normalizeE164AR(raw) {
  let d = digits(raw);
  if (!d) return "";

  // ya canónico 549...
  if (d.startsWith("549")) return `+${d}`;

  // caso 54{area}15{local} -> +549{area}{local}
  const m5415 = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, local] = m5415;
    return `+549${area}${local}`;
  }

  // si viene 54... sin 15, lo dejamos +54... (ojo: no siempre es canónico, pero es AR)
  if (d.startsWith("54")) return `+${d}`;

  // si viene con 00
  if (d.startsWith("00")) d = d.slice(2);

  // si viene con 0 adelante
  d = d.replace(/^0+/, "");

  // NO inventamos país acá; si no es 54, no es AR canónico
  return `+${d}`;
}

// Candidatos de envío (Meta quiere dígitos sin '+'): probamos 549 y 5415
function candidatesForSendAR(toRaw) {
  const d0 = digits(toRaw);

  // ya 549...
  if (/^549\d+$/.test(d0)) {
    const areaLocal = d0.slice(3);
    const m = areaLocal.match(/^(\d{2,4})(\d+)$/);
    if (!m) return [d0];
    const [, area, rest] = m;
    return PREFER_5415 ? [`54${area}15${rest}`, d0] : [d0, `54${area}15${rest}`];
  }

  // ya 5415...
  const m5415 = d0.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, rest] = m5415;
    return PREFER_5415 ? [d0, `549${area}${rest}`] : [`549${area}${rest}`, d0];
  }

  // fallback: inferir area/local (simple)
  let d = d0;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");

  // heurística: CABA 11 + 8, si no 3 dígitos area
  const area = /^11\d{8}$/.test(d) ? d.slice(0, 2) : d.slice(0, 3);
  const local = d.slice(area.length);

  const v549 = `549${area}${local}`;
  const v5415 = `54${area}15${local}`;
  return PREFER_5415 ? [v5415, v549] : [v549, v5415];
}

// Canonical convId AR (+549...) robusto: intenta con raw y con candidatos
function canonicalConvIdAR(raw) {
  const tryOne = (x) => {
    const n = normalizeE164AR(x);
    return n && n.startsWith("+54") ? n : "";
  };

  const direct = tryOne(raw);
  if (direct) return direct;

  const cands = candidatesForSendAR(raw);
  for (const c of cands) {
    const n = tryOne(c);
    // preferimos canónico +549 si aparece
    if (n && n.startsWith("+549")) return n;
    if (n) return n;
  }
  return "";
}

// ====== sanitize (Meta) ======
// ✅ Mantiene saltos de línea (\n) para que los combos lleguen separados.
// Limpia CR/TAB y normaliza espacios por línea (sin romper \n).
function sanitizeParamServer(input) {
  if (input === "\u200B") return input; // ZWSP permitido
  let x = String(input ?? "");

  // normalizar saltos
  x = x.replace(/\r\n?/g, "\n"); // CRLF/CR -> LF
  x = x.replace(/\t+/g, " ");    // tabs -> espacio

  // no permitir demasiadas líneas vacías
  x = x.replace(/\n{3,}/g, "\n\n"); // max 2 saltos seguidos

  // limpiar espacios por línea (sin usar \s que rompe \n)
  x = x
    .split("\n")
    .map((line) => {
      let y = line;
      y = y.replace(/[\f\v]+/g, " ");
      y = y.replace(/ {5,}/g, "    "); // por compat con tu regla vieja
      y = y.replace(/ {2,}/g, " ");    // colapsa espacios (solo espacios)
      return y.trim();
    })
    .join("\n");

  x = x.trim();

  const MAX_PARAM_LEN = 1000;
  if (x.length > MAX_PARAM_LEN) x = x.slice(0, MAX_PARAM_LEN - 1) + "…";
  return x;
}

function stripZWSP(s) {
  const x = String(s ?? "");
  return x === "\u200B" ? "" : x;
}

function previewFromVars(tName, vars) {
  const v1 = stripZWSP(vars?.[0]);
  const v2 = stripZWSP(vars?.[1]);
  const v3 = stripZWSP(vars?.[2]);

  let out = "";
  if (tName === "reengage_free_text") {
    out = v1 || `[Plantilla ${tName}]`;
  } else {
    if (v1 || v2) out += `Hola${v1 ? " " + v1 : ""}${v2 ? ", soy " + v2 : ""}.`;
    if (v3) out += (out ? "\n" : "") + v3;
    if (!out) out = `[Plantilla ${tName}]`;
  }

  // Preview “corto” para conversaciones/lista
  const MAX = 220;
  const compact = out.replace(/\s+/g, " ").trim();
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
    const email = (decoded.email || "").toLowerCase();

    // ── Resolver PHONE_ID por seller
    let phoneEnvKey = null;
    try {
      const docSnap = await db.collection("sellers").doc(uid).get();
      if (docSnap.exists) phoneEnvKey = docSnap.data()?.phoneEnvKey || null;
    } catch { }

    if (!phoneEnvKey && email) phoneEnvKey = EMAIL_TO_ENV[email] || "META_WA_PHONE_ID";

    const PHONE_ID =
      (phoneEnvKey && process.env[phoneEnvKey]) ||
      process.env.META_WA_PHONE_ID ||
      process.env.META_WA_PHONE_ID_0453 ||
      process.env.META_WA_PHONE_ID_8148;

    const TOKEN = process.env.META_WA_TOKEN;

    if (!PHONE_ID || !TOKEN) {
      return res
        .status(500)
        .json({ error: `Missing PHONE_ID (${phoneEnvKey || "null"}) or META_WA_TOKEN` });
    }

    // ── Body (acepta payload viejo y nuevo)
    const input = await readJson(req);

    // Nuevo formato: { to, template: { name, language, components } }
    // Viejo formato: { phone, components }
    const toRaw = input?.to || input?.phone || input?.contactId || input?.contact || input?.number;
    if (!toRaw) return res.status(400).json({ error: "Missing phone/to" });

    const tplObj = input?.template || null;

    const requested = String(input?.templateName || input?.name || tplObj?.name || DEFAULT_TEMPLATE).trim();
    const tName = ALLOWED_TEMPLATES.has(requested) ? requested : DEFAULT_TEMPLATE;

    // language puede venir como string ("es_AR") o como { code: "es_AR" }
    const lang = String(input?.languageCode || tplObj?.language?.code || tplObj?.language || "es_AR");

    // components puede venir en input.components o en template.components
    const incomingComponents =
      Array.isArray(input?.components) && input.components.length
        ? input.components
        : Array.isArray(tplObj?.components) && tplObj.components.length
          ? tplObj.components
          : [];

    // ====== Fallback vars si no vienen components ======
    const pick = (...keys) => {
      for (const k of keys) {
        const v = typeof input?.[k] === "string" ? input[k] : null;
        if (v && v.trim() !== "") return v;
      }
      return null;
    };

    const vFallback = [
      sanitizeParamServer(pick("v1", "var1", "body1", "saludo", "nombre", "name1") || "\u200B"),
      sanitizeParamServer(pick("v2", "var2", "body2", "vendedor", "seller", "name2") || "\u200B"),
      sanitizeParamServer(pick("v3", "var3", "body3", "promos", "texto", "lista", "body", "name3") || "\u200B"),
    ];

    // ====== Normalizar components/body/params ======
    const norm = (incomingComponents || []).map((c) => ({
      type: String(c?.type || "body").toLowerCase(),
      parameters: (c?.parameters || []).map((p) => ({
        type: "text",
        text: sanitizeParamServer(p?.text),
      })),
    }));

    const bodyComp = norm.find((c) => c.type === "body");
    const providedParams = bodyComp?.parameters || [];

    const expectedCount =
      TEMPLATE_PARAM_COUNT[tName] ??
      Math.max(1, providedParams.length || 1);

    // vars finales: EXACTA cantidad esperada
    const vars = [];
    for (let i = 0; i < expectedCount; i++) {
      const fromProvided = providedParams?.[i]?.text;
      const fromFallback = vFallback?.[i] ?? "\u200B";
      vars.push(sanitizeParamServer(fromProvided ?? fromFallback));
    }

    const fixedComponents = [
      {
        type: "body",
        parameters: vars.map((x) => ({ type: "text", text: x })),
      },
    ];

    // ====== Seguridad / compliance: opt-in ======
    try {
      const convIdForCheck = canonicalConvIdAR(toRaw);
      if (!convIdForCheck) return res.status(400).json({ error: "Invalid phone (not AR canonical)" });

      const convSnap = await db.collection("conversations").doc(convIdForCheck).get();
      if (!convSnap.exists) {
        return res.status(404).json({
          error: "Conversation not found for opt-in check",
          details: { convId: convIdForCheck },
        });
      }

      const dataConv = convSnap.data() || {};
      const marketingOptInValue = dataConv.marketingOptIn; // true|false|undefined
      const optIn = dataConv.optIn === true;

      if (marketingOptInValue === false) {
        return res.status(403).json({
          error: "Contact opted-out of marketing (marketingOptIn=false)",
          details: { optIn, marketingOptIn: marketingOptInValue, REQUIRE_MARKETING_OPTIN },
        });
      }

      const allowed = REQUIRE_MARKETING_OPTIN ? (marketingOptInValue === true) : (optIn === true);

      if (!allowed) {
        return res.status(403).json({
          error: "Contact is not opted-in for marketing messages",
          details: { optIn, marketingOptIn: marketingOptInValue, REQUIRE_MARKETING_OPTIN },
        });
      }
    } catch (e) {
      console.error("[send-template] opt-in check failed:", e);
      return res.status(500).json({ error: "Failed opt-in validation" });
    }

    // ====== Envío a Graph (probando 549/5415) ======
    const cands = candidatesForSendAR(toRaw);

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
      // 131030 (sandbox/whitelist) => probamos el otro candidato
      if (data?.error?.code !== 131030) break;
    }

    if (!upstreamOk) {
      console.error(
        "[WA TEMPLATE ERROR]",
        JSON.stringify({ toRaw, cands, template: tName, data: lastErr }, null, 2)
      );
      return res.status(400).json({ error: lastErr?.error || lastErr });
    }

    // ====== Guardar OUT en Firestore (convId canónico) ======
    try {
      const msgId = data?.messages?.[0]?.id || data?.message_id || null;

      const convId = canonicalConvIdAR(usedToDigits || toRaw);
      const textPreview = previewFromVars(tName, vars);

      const convRef = db.collection("conversations").doc(convId);

      await convRef.set(
        {
          contactId: convId,
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
          vars, // ✅ para render exacto en front (ahora puede traer \n)
          textPreview,
          businessPhoneId: PHONE_ID,
          timestamp: FieldValue.serverTimestamp(),
          status: "sent",
          sendVariant: usedToDigits?.startsWith("549") ? "549" : "5415",
          to: convId,
          toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
          rawResponse: data,
        },
        { merge: true }
      );
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
    const status = err?.statusCode || 500;
    console.error("send-template fatal:", err);
    return res.status(status).json({ error: String(err?.message || err) });
  }
}