import admin from "../lib/firebaseAdmin.js";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeE164AR, resolveConversationContext } from "../lib/conversationScope.js";

const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";
const REQUIRE_MARKETING_OPTIN =
  String(process.env.REQUIRE_MARKETING_OPTIN || "0") === "1";

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

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function candidatesForSendAR(toRaw) {
  const d0 = String(toRaw || "").replace(/\D+/g, "");

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

function toIsoOrNull(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function buildEligibility(dataConv = {}) {
  const marketingOptIn = dataConv.marketingOptIn;
  const optIn = dataConv.optIn === true;

  if (marketingOptIn === false) {
    return {
      canSend: false,
      status: "opted_out",
      reason: "El contacto se dio de baja de marketing (marketingOptIn=false).",
      optIn,
      marketingOptIn,
    };
  }

  if (REQUIRE_MARKETING_OPTIN) {
    const allowed = marketingOptIn === true;
    return {
      canSend: allowed,
      status: allowed ? "sendable" : "missing_marketing_optin",
      reason: allowed
        ? "Tiene marketingOptIn=true."
        : "Este backend exige marketingOptIn=true para enviar plantillas de marketing.",
      optIn,
      marketingOptIn,
    };
  }

  const allowed = optIn === true;
  const legacy = allowed && marketingOptIn === undefined;

  return {
    canSend: allowed,
    status: allowed ? (legacy ? "sendable_legacy" : "sendable") : "missing_optin",
    reason: allowed
      ? legacy
        ? "Se puede enviar en modo legacy: optIn=true y marketingOptIn todavía no está definido."
        : "Tiene optIn válido para marketing."
      : "El contacto no tiene optIn=true.",
    optIn,
    marketingOptIn,
  };
}

export default async function handler(req, res) {
  try {
    setCors(req, res);

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    try {
      await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const input = await readJson(req);
    const phoneRaw =
      input?.phone || input?.to || input?.contactId || input?.contact || input?.number || "";

    if (!phoneRaw) {
      return res.status(400).json({
        ok: false,
        error: "Missing phone/to",
      });
    }

    const normalizedPhone = normalizeE164AR(phoneRaw);
    if (!normalizedPhone) {
      return res.status(400).json({
        ok: false,
        canSend: false,
        status: "invalid_phone",
        reason: "No se pudo normalizar el número al formato canónico.",
        phone: {
          raw: String(phoneRaw),
          normalized: null,
          convId: null,
          candidates: candidatesForSendAR(phoneRaw),
        },
      });
    }

    const db = getFirestore();
    const ctx = await resolveConversationContext(db, {
      conversationId: String(input?.conversationId || "").trim(),
      rawPhone: normalizedPhone,
      phoneId: String(input?.fromWaPhoneId || input?.phoneId || "").trim(),
      preferScopedId: false,
    });

    if (!ctx?.data) {
      return res.status(200).json({
        ok: true,
        canSend: false,
        status: "missing_conversation",
        reason: "No existe conversación previa para ese número en Firestore.",
        phone: {
          raw: String(phoneRaw),
          normalized: normalizedPhone,
          convId: ctx?.conversationId || null,
          candidates: candidatesForSendAR(phoneRaw),
        },
        policy: {
          requireMarketingOptIn: REQUIRE_MARKETING_OPTIN,
          allowLegacyOptIn: !REQUIRE_MARKETING_OPTIN,
        },
        conversation: null,
      });
    }

    const dataConv = ctx.data || {};
    const eligibility = buildEligibility(dataConv);

    return res.status(200).json({
      ok: true,
      ...eligibility,
      phone: {
        raw: String(phoneRaw),
        normalized: normalizeE164AR(phoneRaw),
        convId: ctx?.conversationId || null,
        candidates: candidatesForSendAR(phoneRaw),
      },
      policy: {
        requireMarketingOptIn: REQUIRE_MARKETING_OPTIN,
        allowLegacyOptIn: !REQUIRE_MARKETING_OPTIN,
      },
      conversation: {
        exists: true,
        contactId: dataConv.contactId || normalizedPhone,
        conversationId: ctx?.conversationId || null,
        optIn: dataConv.optIn === true,
        marketingOptIn: dataConv.marketingOptIn,
        lastInboundAt: toIsoOrNull(dataConv.lastInboundAt),
        lastMessageAt: toIsoOrNull(dataConv.lastMessageAt),
        assignedToUid: dataConv.assignedToUid || null,
        assignedToEmail: dataConv.assignedToEmail || null,
        labels: Array.isArray(dataConv.labels) ? dataConv.labels : [],
      },
    });
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error("check-template-eligibility fatal:", err);
    return res.status(status).json({ error: String(err?.message || err) });
  }
}
