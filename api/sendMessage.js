// backend/api/sendMessage.js

import {
  buildContactDocIds,
  buildScopedConversationId,
  digits,
  normalizeE164AR,
  resolveConversationContext,
} from "../lib/conversationScope.js";

// ====== CORS ======
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*", // en prod poné tu dominio
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const setCors = (res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
};

// ====== Constantes ======
const GRAPH_BASE = "https://graph.facebook.com/v23.0";
const DEFAULT_PHONE_ID = process.env.META_WA_PHONE_ID || "";
const TOKEN = process.env.META_WA_TOKEN || "";
const PREFER_5415 = String(process.env.META_WA_PREFER_5415 || "") === "1";
const REQUIRE_MARKETING_OPTIN =
  String(process.env.REQUIRE_MARKETING_OPTIN || "0") === "1";

// Resolver phone id por seller
const EMAIL_TO_ENV = {
  "christian15366@gmail.com": "META_WA_PHONE_ID_0453",
  "julicisneros.89@gmail.com": "META_WA_PHONE_ID_8148",
  "lunacami00@gmail.com": "META_WA_PHONE_ID",
  "escalantefr.p@gmail.com": "META_WA_PHONE_ID_VM",
  "laurialvarez456@gmail.com": "META_WA_PHONE_ID_1002",
};

// ---------- helpers de números (AR) ----------
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

// ---------- Graph API ----------
async function sendToGraph(phoneId, toDigits, payload) {
  const url = `${GRAPH_BASE}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: toDigits, ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function getUserWaPhoneId(db, senderUid) {
  try {
    const snap = await db.collection("users").doc(String(senderUid || "")).get();
    if (!snap.exists) return "";
    return String(snap.data()?.waPhoneId || "").trim();
  } catch {
    return "";
  }
}

async function resolveSellerPhoneId(db, senderUid, senderEmail, defaultPhoneId) {
  const email = String(senderEmail || "").trim().toLowerCase();
  let phoneEnvKey = null;

  try {
    const snap = await db.collection("sellers").doc(String(senderUid || "")).get();
    if (snap.exists) {
      phoneEnvKey = String(snap.data()?.phoneEnvKey || "").trim() || null;
    }
  } catch {
    // ignore
  }

  if (!phoneEnvKey && email) {
    phoneEnvKey = EMAIL_TO_ENV[email] || null;
  }

  if (phoneEnvKey && process.env[phoneEnvKey]) {
    return {
      phoneId: process.env[phoneEnvKey],
      source: "seller-env",
      phoneEnvKey,
    };
  }

  const waPhoneId = await getUserWaPhoneId(db, senderUid);
  if (waPhoneId) {
    return {
      phoneId: waPhoneId,
      source: "users.waPhoneId",
      phoneEnvKey: null,
    };
  }

  return {
    phoneId: defaultPhoneId || "",
    source: defaultPhoneId ? "default-env" : "default-missing",
    phoneEnvKey,
  };
}

// ---------- resolver emisor ----------
async function resolvePhoneIdFor(
  db,
  { toRaw, conversationId, explicitPhoneId, defaultPhoneId, senderUid, senderEmail }
) {
  if (explicitPhoneId) {
    const ctx = await resolveConversationContext(db, {
      conversationId,
      rawPhone: toRaw,
      phoneId: explicitPhoneId,
      preferScopedId: true,
    });

    return {
      phoneId: explicitPhoneId,
      source: "explicit",
      phoneEnvKey: null,
      normalizedPhone: ctx?.normalizedPhone || normalizeE164AR(toRaw),
      conversationId: ctx?.conversationId || buildScopedConversationId(toRaw, explicitPhoneId),
      conversationData: ctx?.data || null,
    };
  }

  const ctx = await resolveConversationContext(db, {
    conversationId,
    rawPhone: toRaw,
    preferScopedId: false,
  });

  const fromConversation = String(
    ctx?.data?.lastInboundPhoneId ||
      ctx?.data?.scopedPhoneNumberId ||
      ctx?.data?.businessPhoneId ||
      ""
  ).trim();

  if (fromConversation) {
    return {
      phoneId: fromConversation,
      source: "conversation.phoneId",
      phoneEnvKey: null,
      normalizedPhone: ctx?.normalizedPhone || normalizeE164AR(toRaw),
      conversationId: ctx?.conversationId || buildScopedConversationId(toRaw, fromConversation),
      conversationData: ctx?.data || null,
    };
  }

  const sellerResolved = await resolveSellerPhoneId(db, senderUid, senderEmail, defaultPhoneId);
  const sellerPhoneId = sellerResolved?.phoneId || "";
  const sellerCtx = await resolveConversationContext(db, {
    conversationId,
    rawPhone: toRaw,
    phoneId: sellerPhoneId,
    preferScopedId: true,
  });

  return {
    ...sellerResolved,
    normalizedPhone: sellerCtx?.normalizedPhone || normalizeE164AR(toRaw),
    conversationId:
      sellerCtx?.conversationId || buildScopedConversationId(toRaw, sellerPhoneId),
    conversationData: sellerCtx?.data || null,
  };
}

// ---------- elegibilidad para templates ----------
async function assertTemplateEligibility(db, { rawPhone, conversationId = "", phoneId = "" }) {
  const ctx = await resolveConversationContext(db, {
    conversationId,
    rawPhone,
    phoneId,
    preferScopedId: false,
  });

  const normalizedPhone = ctx?.normalizedPhone || normalizeE164AR(rawPhone);
  if (!normalizedPhone) {
    const err = new Error("invalid_phone_for_template_check");
    err.statusCode = 400;
    throw err;
  }

  if (!ctx?.data) {
    const err = new Error("conversation_not_found_for_optin_check");
    err.statusCode = 404;
    throw err;
  }

  const data = ctx.data || {};
  const optIn = data.optIn === true;
  const marketingOptIn = data.marketingOptIn;

  if (marketingOptIn === false) {
    const err = new Error("contact_opted_out_of_marketing");
    err.statusCode = 403;
    err.details = { optIn, marketingOptIn, conversationId: ctx.conversationId };
    throw err;
  }

  const allowed = REQUIRE_MARKETING_OPTIN ? marketingOptIn === true : optIn === true;

  if (!allowed) {
    const err = new Error("contact_not_opted_in_for_marketing");
    err.statusCode = 403;
    err.details = {
      optIn,
      marketingOptIn,
      REQUIRE_MARKETING_OPTIN,
      conversationId: ctx.conversationId,
    };
    throw err;
  }
}

// ---------- helpers template text ----------
function stripZWSP(value) {
  const x = String(value ?? "");
  return x === "​" ? "" : x;
}

function getTemplateBodyParams(template) {
  const comps = Array.isArray(template?.components) ? template.components : [];
  const bodyComp =
    comps.find((c) => String(c?.type || "").toLowerCase() === "body") || comps[0] || null;

  return Array.isArray(bodyComp?.parameters) ? bodyComp.parameters : [];
}

function buildResolvedTemplateText(template) {
  try {
    const params = getTemplateBodyParams(template);
    const parts = params
      .map((x) => stripZWSP(typeof x?.text === "string" ? x.text : ""))
      .filter(Boolean);

    const p = (i) => stripZWSP(typeof params[i]?.text === "string" ? params[i].text : "");
    const name = String(template?.name || "").trim();
    const lowerName = name.toLowerCase();
    const envReengage = String(
      process.env.VITE_WA_REENGAGE_TEMPLATE || "reengage_free_text"
    ).toLowerCase();
    const brandName = String(process.env.VITE_BRAND_NAME || "HogarCril").trim();
    const isReengage = lowerName === envReengage || lowerName === "reengage_free_text";

    if (isReengage) {
      const client = p(0);
      const seller = p(1);
      const freeText = p(2);

      if (freeText && freeText.toLowerCase() !== brandName.toLowerCase()) {
        return freeText.trim();
      }

      const hello = client ? `Hola ${client}` : "Hola";
      const sellerPart = seller ? `, soy ${seller}` : "";
      const brandPart = brandName ? ` de ${brandName}` : "";
      return `${hello}${sellerPart}${brandPart}.`.trim();
    }

    return parts.length
      ? `[Plantilla ${name || "template"}] ${parts.join(" • ")}`
      : `[Plantilla ${name || "template"}]`;
  } catch {
    return `[Plantilla ${template?.name || "template"}]`;
  }
}

function buildPreviewForSent({ sentType, text, template, image, audio, document }) {
  if (sentType === "text") {
    return typeof text === "string" ? text : (text?.body || "");
  }

  if (sentType === "template") {
    const resolved = buildResolvedTemplateText(template);
    return String(resolved || "")
      .replace(/\n+/g, " • ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  if (sentType === "image") return image?.caption || "[Imagen]";
  if (sentType === "audio") return "[Audio]";
  if (sentType === "document") return document?.caption || "[Documento]";
  return "";
}

// ====== HANDLER ======
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    if (!TOKEN) return res.status(500).json({ error: "server_misconfigured" });

    // Import dinámico
    const fb = await import("../lib/firebaseAdmin.js");
    const admin = fb.default;
    const { db, FieldValue } = fb;

    // ✅ Auth Firebase (obligatorio)
    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: "Missing Bearer token" });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const senderUid = decoded?.uid || null;
    const senderEmail = String(decoded?.email || "").trim().toLowerCase();

    // Body robusto
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        body = {};
      }
    } else if (!body || typeof body !== "object") {
      body = {};
    }

    let {
      to,
      text,
      template,
      image,
      audio,
      audioMeta,
      document,
      conversationId,
      fromWaPhoneId,
      phoneId,
      replyTo,
      sellerName, // opcional
    } = body;

    if (!to) return res.status(400).json({ error: "missing_to" });
    if (!text && !template && !image && !audio && !document) {
      return res.status(400).json({ error: "missing_text_or_template_or_media" });
    }

    const recipients = Array.isArray(to) ? to : [to];
    const results = [];

    for (const raw of recipients) {
      const resolvedPhone = await resolvePhoneIdFor(db, {
        toRaw: raw,
        conversationId,
        explicitPhoneId: fromWaPhoneId || phoneId,
        defaultPhoneId: DEFAULT_PHONE_ID,
        senderUid,
        senderEmail,
      });

      const PHONE_ID = resolvedPhone?.phoneId || "";
      const phoneSource = resolvedPhone?.source || "unknown";
      const targetPhone = resolvedPhone?.normalizedPhone || normalizeE164AR(raw);

      if (!PHONE_ID) {
        return res.status(500).json({ error: "no_phone_id_available" });
      }

      if (!targetPhone) {
        return res.status(400).json({ error: "invalid_to_phone", to: raw });
      }

      if (template) {
        try {
          await assertTemplateEligibility(db, {
            rawPhone: targetPhone,
            conversationId,
            phoneId: PHONE_ID,
          });
        } catch (e) {
          return res.status(e.statusCode || 403).json({
            error: e.message || "template_optin_validation_failed",
            details: e.details || null,
            to: raw,
          });
        }
      }

      const cands = candidatesForSendAR(targetPhone);
      let delivered = null;
      let usedToDigits = null;
      let usedVariant = null;
      let lastErr = null;

      for (const cand of cands) {
        let payload;

        if (image) payload = { type: "image", image };
        else if (audio) payload = { type: "audio", audio };
        else if (document) payload = { type: "document", document };
        else if (template) payload = { type: "template", template };
        else {
          payload = {
            type: "text",
            text: {
              body: typeof text === "string" ? text : (text?.body || ""),
              preview_url: false,
            },
          };
        }

        const ctxId = replyTo?.wamid || replyTo?.id;
        if (ctxId) payload.context = { message_id: String(ctxId) };

        const r = await sendToGraph(PHONE_ID, cand, payload);
        if (r.ok) {
          delivered = r.json;
          usedToDigits = cand;
          usedVariant = cand.startsWith("549") ? "549" : "5415";
          break;
        }

        lastErr = r.json;
        if (r?.json?.error?.code !== 131030) break;
      }

      const normalizedPhone = normalizeE164AR(usedToDigits || cands[0] || targetPhone);
      const convId =
        resolvedPhone?.conversationId || buildScopedConversationId(normalizedPhone, PHONE_ID);
      const convRef = db.collection("conversations").doc(convId);

      const contactDocIds = buildContactDocIds({ conversationId: convId, normalizedPhone });
      const baseContactData = {
        phone: normalizedPhone,
        waId: digits(normalizedPhone),
        conversationId: convId,
        scopedPhoneNumberId: PHONE_ID,
        updatedAt: FieldValue.serverTimestamp(),
      };
      for (const contactDocId of contactDocIds) {
        await db.collection("contacts").doc(contactDocId).set(baseContactData, { merge: true });
      }

      await convRef.set(
        {
          contactId: normalizedPhone,
          clientPhone: normalizedPhone,
          conversationId: convId,
          scopedPhoneNumberId: PHONE_ID,
          businessPhoneId: PHONE_ID,
          lastMessageAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const wamid = delivered?.messages?.[0]?.id || `out_${Date.now()}`;
      const sentType = image
        ? "image"
        : audio
        ? "audio"
        : document
        ? "document"
        : template
        ? "template"
        : "text";

      const msgDoc = {
        direction: "out",
        type: sentType,
        timestamp: FieldValue.serverTimestamp(),
        to: normalizedPhone,
        toRawSent: usedToDigits ? `+${usedToDigits}` : undefined,
        sendVariant: usedVariant || undefined,
        businessPhoneId: PHONE_ID,
        businessPhoneSource: phoneSource,
        status: delivered ? "sent" : "error",
        raw: delivered || undefined,
        error: delivered ? undefined : (lastErr || { message: "send_failed" }),

        // ✅ Auditoría
        sentByUid: senderUid || undefined,
        sentByEmail: senderEmail || undefined,
        sellerName: sellerName || undefined,
      };

      if (sentType === "text") {
        msgDoc.text = typeof text === "string" ? text : (text?.body || "");
      }

      if (sentType === "template") {
        msgDoc.template = {
          name: template?.name || null,
          language: template?.language || null,
          components: Array.isArray(template?.components) ? template.components : [],
        };

        const vars = getTemplateBodyParams(msgDoc.template).map((x) =>
          typeof x?.text === "string" ? x.text : ""
        );
        const resolvedText = buildResolvedTemplateText(msgDoc.template);

        msgDoc.vars = vars;
        msgDoc.text = resolvedText;
        msgDoc.resolvedText = resolvedText;
        msgDoc.body = resolvedText;
        msgDoc.textPreview = buildPreviewForSent({
          sentType: "template",
          template: msgDoc.template,
        });
      }

      if (sentType === "image") {
        const imgUrl = image?.link || image?.url || null;
        msgDoc.media = {
          kind: "image",
          ...(imgUrl ? { link: imgUrl, url: imgUrl } : {}),
          ...(image?.id ? { id: image.id } : {}),
          ...(image?.caption ? { caption: image.caption } : {}),
        };
        if (imgUrl) msgDoc.mediaUrl = imgUrl;
      }

      if (sentType === "audio") {
        const audUrl = audio?.link || audio?.url || null;
        msgDoc.media = {
          kind: "audio",
          ...(audUrl ? { link: audUrl, url: audUrl } : {}),
          ...(audio?.id ? { id: audio.id } : {}),
          ...(audioMeta?.mime ? { mime: audioMeta.mime } : {}),
          ...(audioMeta?.filename ? { filename: audioMeta.filename } : {}),
          ...(Number.isFinite(Number(audioMeta?.duration))
            ? { duration: Number(audioMeta.duration) }
            : {}),
          ...(typeof audioMeta?.voice === "boolean" ? { voice: audioMeta.voice } : {}),
          ...(Number.isFinite(Number(audioMeta?.size))
            ? { size: Number(audioMeta.size) }
            : {}),
          ...(typeof audioMeta?.converted === "boolean"
            ? { converted: audioMeta.converted }
            : {}),
        };
        if (audUrl) msgDoc.mediaUrl = audUrl;
      }

      if (sentType === "document") {
        const docUrl = document?.link || document?.url || null;
        msgDoc.media = {
          kind: "document",
          ...(docUrl ? { link: docUrl, url: docUrl } : {}),
          ...(document?.id ? { id: document.id } : {}),
          ...(document?.caption ? { caption: document.caption } : {}),
          ...(document?.filename ? { filename: document.filename } : {}),
        };
        if (docUrl) msgDoc.mediaUrl = docUrl;
      }

      Object.keys(msgDoc).forEach((k) => msgDoc[k] === undefined && delete msgDoc[k]);

      if (replyTo) {
        msgDoc.replyTo = {
          id: replyTo.id || null,
          type: replyTo.type || "text",
          text: (replyTo.text || replyTo.snippet || "").slice(0, 200),
          snippet: (replyTo.snippet || replyTo.text || "").slice(0, 200),
          wamid: replyTo.wamid || null,
          from: replyTo.from || null,
          createdAt: replyTo.createdAt || null,
        };
      }

      await convRef.collection("messages").doc(wamid).set(msgDoc, { merge: true });

      const preview = buildPreviewForSent({ sentType, text, template, image, audio, document });

      await convRef.set(
        {
          contactId: normalizedPhone,
          clientPhone: normalizedPhone,
          conversationId: convId,
          scopedPhoneNumberId: PHONE_ID,
          businessPhoneId: PHONE_ID,
          lastMessageAt: FieldValue.serverTimestamp(),
          lastMessageText: String(preview || "").slice(0, 500),
          lastMessageDirection: "out",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      results.push({
        to: convId,
        phone: normalizedPhone,
        ok: !!delivered,
        id: wamid,
        phoneId: PHONE_ID,
        phoneSource,
        sendVariant: msgDoc.sendVariant,
        error: msgDoc.error,
      });
    }

    return res.status(200).json({ ok: results.every((r) => r.ok), results });
  } catch (err) {
    setCors(res);
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: err.message || "internal_error" });
  }
}