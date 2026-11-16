import { getCoexistenceConfig, completeCoexistence } from "./coexistenceOnboarding.js";
import admin, { db, FieldValue } from "./firebaseAdmin.js";
import { groupUniqueZonePhones, buildExcelAnalytics } from "./crmExcelAnalytics.js";
import { buildMarketingPerformance, normalizeReferral, optionalNumber } from "./marketingAnalytics.js";
import { getMetaMarketingSnapshot } from "./metaMarketing.js";
import { simulateFlow, validateFlowDefinition } from "./chatbotFlow.js";
import { chatbotManagement, isChatbotManagementAction } from "./chatbotManagement.js";
import { chatbotOperations, isChatbotOperationAction } from "./chatbotOperations.js";
import {
  digits,
  getConversationContactPhone,
  getConversationPhoneId,
  normalizeE164AR,
  resolveConversationContext,
  toMillisMaybe,
} from "./conversationScope.js";

export const CRM_STATUSES = [
  "nuevo",
  "pendiente",
  "en_seguimiento",
  "atendido",
  "no_contesto",
  "vendido",
  "no_interesa",
  "numero_incorrecto",
];

// Valores de SEGUIMIENTO/LISTAS del Excel. Son independientes de gestionStatus.
export const CRM_QUALIFICATIONS = ["Sin calificar", "Calificado", "No calificado"];
export const CRM_STAGES = ["Nuevo", "Contactado", "Relevamiento", "Presupuesto enviado", "Datos de pago enviados", "Venta cerrada"];
export const CRM_OUTCOMES = ["Activo", "Vendido", "Perdido", "Fantasma", "Congelado"];
export const CRM_UNQUALIFIED_REASONS = ["Fuera de zona", "Producto que no vendemos", "Consulta no comercial", "Solo curiosidad", "Número equivocado", "Otro"];
export const CRM_LOSS_REASONS = ["Dejó de responder", "Obra todavía no empieza", "Espera cobrar", "Comparando presupuestos", "Precio", "Compró en otro lado", "Sin stock", "Costo o demora de envío", "Otro"];

const CRM_STATUS_SET = new Set(CRM_STATUSES);
const TERMINAL_OR_ATTENDED = new Set([
  "atendido",
  "no_contesto",
  "vendido",
  "no_interesa",
  "numero_incorrecto",
]);
const DEFAULT_ADMIN_EMAILS = new Set([
  "alainismael95@gmail.com",
  "federudiero@gmail.com",
  "fede_rudiero@gmail.com",
]);

// Es la misma configuración funcional ya usada por el frontend actual para
// permitir que los vendedores regionales reclamen conversaciones compartidas.
const SHARED_INBOX_REGIONS = [
  {
    zone: "Córdoba",
    phoneIds: ["807747825759387", "729326663073216", "834087939786971"],
    emails: [
      "christian15366@gmail.com",
      "lunacami00@gmail.com",
      "julicisneros.89@gmail.com",
    ],
  },
  {
    zone: "Villa María",
    phoneIds: ["1126748053852551", "987669861103912"],
    emails: ["escalantefr.p@gmail.com", "laurialvarez456@gmail.com"],
  },
];

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function parseBody(req) {
  if (req?.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req?.body || "{}");
  } catch {
    return {};
  }
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  if (typeof value?.toMillis === "function") {
    try {
      return new Date(value.toMillis());
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && Number.isFinite(value?._seconds)) {
    return new Date(value._seconds * 1000 + Number(value?._nanoseconds || 0) / 1e6);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestamp(value = new Date()) {
  const date = toDate(value) || new Date();
  return admin.firestore.Timestamp.fromDate(date);
}

function inRange(value, start, end) {
  const ms = toMillisMaybe(value);
  if (!ms) return false;
  if (start && ms < start.getTime()) return false;
  if (end && ms >= end.getTime()) return false;
  return true;
}

function argentinaDayKey(value) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseRange(filters = {}) {
  const start = toDate(filters.start);
  const end = toDate(filters.end);
  return {
    start,
    end: end && start && end <= start ? new Date(start.getTime() + 86400000) : end,
  };
}

function sanitizeEventId(value) {
  return cleanString(value, 700).replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function normalizedStatus(data = {}) {
  const current = cleanString(data.gestionStatus || data.gestionEstado, 80);
  if (CRM_STATUS_SET.has(current)) return current;

  const labels = Array.isArray(data.labels)
    ? data.labels.map((label) => cleanString(label, 100).toLowerCase())
    : [];
  if (labels.includes("vendido")) return "vendido";
  if (labels.includes("no_interesa") || labels.includes("no interesa")) return "no_interesa";
  if (labels.includes("no_contesto") || labels.includes("no contestó")) return "no_contesto";
  if (labels.includes("seguimiento")) return "en_seguimiento";
  if (cleanString(data.stage).toLowerCase() === "cerrado" || cleanString(data.status).toLowerCase() === "closed") {
    return "atendido";
  }
  return "nuevo";
}

function conversationPhone(data = {}) {
  return normalizeE164AR(
    data.contactId || data.clientPhone || data.phone || data.waId || data.to || ""
  );
}

function conversationName(data = {}, contact = {}) {
  return cleanString(
    data.displayName ||
      data.contactName ||
      data.profileName ||
      data.name ||
      contact.displayName ||
      contact.name ||
      contact.profileName ||
      conversationPhone(data) ||
      "Contacto",
    300
  );
}

function responseIsConfirmed(data = {}) {
  // Los documentos creados desde Gestión CRM usan este campo para representar
  // exclusivamente el ciclo entrante actual. `null` significa que un nuevo
  // mensaje reabrió la espera; no se reutiliza una respuesta histórica.
  if (Object.prototype.hasOwnProperty.call(data, "currentCycleResponseAt")) {
    return Boolean(data.currentCycleResponseAt);
  }
  const confirmation = cleanString(data.responseConfirmation).toLowerCase();
  const source = cleanString(data.responseSource).toLowerCase();
  return Boolean(
    data.firstSellerResponseAt &&
      confirmation !== "manual" &&
      ["webhook", "automatic", "cloud_api", "confirmed"].includes(confirmation || "confirmed") &&
      source !== "manual"
  );
}

function getSource(data = {}) {
  const referral = data.lastReferral || data.firstReferral || data.referral || {};
  return cleanString(
    data.leadSource ||
      data.leadSourceType ||
      data.origin ||
      data.origen ||
      referral.sourceType ||
      (Object.keys(referral).length ? "anuncio" : "sin_dato"),
    120
  ).toLowerCase();
}

function getCampaign(data = {}) {
  const referral = data.lastReferral || data.firstReferral || data.referral || {};
  return cleanString(
    data.campaign ||
      data.campaignName ||
      data.publication ||
      data.leadSourceHeadline ||
      data.leadSourceId ||
      referral.headline ||
      referral.sourceId ||
      "",
    500
  );
}

function getFollowUp(data = {}) {
  return {
    at: data.followUpAt || data.seguimientoAt || data.nextFollowUpAt || null,
    note: cleanString(data.followUpNote || data.seguimientoNota || data.nextFollowUpNote, 2000),
    completed: Boolean(
      data.followUpCompleted === true ||
        data.seguimientoCompletado === true ||
        data.seguimientoEstado === "completed" ||
        data.followUpDoneAt
    ),
    completedAt: data.followUpCompletedAt || data.seguimientoCompletedAt || data.followUpDoneAt || null,
  };
}

function isUnassigned(data = {}) {
  return !cleanString(data.assignedToUid) && !normalizeEmail(data.assignedToEmail);
}

function getActorPhoneIds(actor, wabaRows = []) {
  const ids = new Set();
  const actorEmail = normalizeEmail(actor?.email);
  const actorUid = cleanString(actor?.uid);

  for (const row of wabaRows) {
    const ownerUid = cleanString(row.ownerUid || row.userUid);
    const ownerEmail = normalizeEmail(row.owner || row.ownerEmail || row.email);
    const allowed = Array.isArray(row.allowedUids)
      ? row.allowedUids.map((value) => cleanString(value))
      : [];
    if (ownerUid === actorUid || ownerEmail === actorEmail || allowed.includes(actorUid)) {
      const id = cleanString(
        row.waPhoneId || row.phoneId || row.phoneNumberId || row.businessPhoneId || row.id
      );
      if (id) ids.add(id);
    }
  }

  for (const region of SHARED_INBOX_REGIONS) {
    if (region.emails.includes(actorEmail)) {
      for (const id of region.phoneIds) ids.add(id);
    }
  }

  return ids;
}

function buildWabaMap(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const ids = [
      row.waPhoneId,
      row.phoneId,
      row.phoneNumberId,
      row.businessPhoneId,
      row.id,
    ]
      .map((value) => cleanString(value))
      .filter((id) => /^\d{8,}$/.test(id));
    for (const id of ids) map.set(id, row);
  }
  return map;
}

function getZoneForConversation(data, wabaMap) {
  const explicit = cleanString(
    data.zone || data.regionLabel || data.regionName || data.regionKey || data.assignedZone,
    160
  );
  if (explicit) return explicit;
  const waba = wabaMap.get(getConversationPhoneId(data));
  return cleanString(waba?.zone || waba?.regionLabel || waba?.regionKey, 160) || "Sin zona";
}

function isAssignedTo(actor, data = {}) {
  const uid = cleanString(data.assignedToUid);
  const email = normalizeEmail(data.assignedToEmail);
  return Boolean((uid && uid === actor.uid) || (email && email === actor.email));
}

function canClaim(actor, data, actorPhoneIds) {
  if (actor.isAdmin || !isUnassigned(data)) return false;
  const phoneId = getConversationPhoneId(data);
  return Boolean(phoneId && actorPhoneIds.has(phoneId));
}

function canReadConversation(actor, data, actorPhoneIds) {
  return actor.isAdmin || isAssignedTo(actor, data) || canClaim(actor, data, actorPhoneIds);
}

function canManageConversation(actor, data) {
  return actor.isAdmin || isAssignedTo(actor, data);
}

function publicChatbotAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, answer]) => {
    const safeKey = cleanString(key, 160);
    if (answer == null || ["string", "number", "boolean"].includes(typeof answer)) {
      return [safeKey, typeof answer === "string" ? cleanString(answer, 2000) : answer];
    }
    if (typeof answer === "object") {
      return [safeKey, Object.fromEntries(Object.entries(answer).slice(0, 20).map(([childKey, childValue]) => [
        cleanString(childKey, 80),
        ["string", "number", "boolean"].includes(typeof childValue) ? (typeof childValue === "string" ? cleanString(childValue, 500) : childValue) : null,
      ]))];
    }
    return [safeKey, null];
  }).filter(([key]) => key));
}

function publicConversation(id, data = {}, contact = {}, wabaMap = new Map(), claimable = false) {
  const followUp = getFollowUp(data);
  const phoneId = getConversationPhoneId(data);
  const firstResponseSeconds = Number(
    data.firstResponseTimeSeconds ?? data.firstEverResponseTimeSec ?? data.responseTimeSec
  );
  const chatbotAnswers = publicChatbotAnswers(data.chatbotAnswers);
  const chatbotAnswer = (...keys) => {
    for (const key of keys) {
      const entry = chatbotAnswers[key];
      const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.value : entry;
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  };

  return {
    id,
    conversationId: id,
    contactId: data.contactId || contact.id || null,
    name: conversationName(data, contact),
    phone: conversationPhone(data) || normalizeE164AR(contact.phone || contact.waId || ""),
    wabaPhoneId: phoneId || null,
    wabaDisplay: cleanString(
      data.lastInboundDisplay || data.businessDisplay || data.waDisplayPhoneNumber || wabaMap.get(phoneId)?.phone,
      120
    ) || null,
    // zone se mantiene operativa (WABA). La zona del cliente NO se infiere desde WABA.
    zone: getZoneForConversation(data, wabaMap),
    crmCustomerZone: cleanString(data.crmCustomerZone, 160) || null,
    crmQualification: CRM_QUALIFICATIONS.includes(data.crmQualification) ? data.crmQualification : null,
    crmUnqualifiedReason: CRM_UNQUALIFIED_REASONS.includes(data.crmUnqualifiedReason) ? data.crmUnqualifiedReason : null,
    crmStage: CRM_STAGES.includes(data.crmStage) ? data.crmStage : null,
    crmOutcome: CRM_OUTCOMES.includes(data.crmOutcome) ? data.crmOutcome : null,
    crmOutcomeReason: CRM_LOSS_REASONS.includes(data.crmOutcomeReason) ? data.crmOutcomeReason : null,
    crmQuoteAmount: optionalNumber(data.crmQuoteAmount),
    crmQuoteCurrency: cleanString(data.crmQuoteCurrency, 12).toUpperCase() || null,
    crmQuoteAt: data.crmQuoteAt || null,
    crmQuoteSellerUid: cleanString(data.crmQuoteSellerUid, 200) || null,
    crmQuoteSellerEmail: normalizeEmail(data.crmQuoteSellerEmail) || null,
    crmConfirmedRevenueAmount: optionalNumber(data.crmConfirmedRevenueAmount),
    crmConfirmedRevenueCurrency: cleanString(data.crmConfirmedRevenueCurrency, 12).toUpperCase() || null,
    crmConfirmedRevenueAt: data.crmConfirmedRevenueAt || null,
    crmConfirmedRevenueByEmail: normalizeEmail(data.crmConfirmedRevenueByEmail) || null,
    crmEconomicVersion: Math.max(0, Math.floor(Number(data.crmEconomicVersion) || 0)),
    firstReferral: normalizeReferral(data.firstReferral || data.referral),
    assignedToUid: cleanString(data.assignedToUid) || null,
    assignedToEmail: normalizeEmail(data.assignedToEmail) || null,
    assignedToName: cleanString(data.assignedToName) || null,
    assignedAt: data.assignedAt || null,
    gestionStatus: normalizedStatus(data),
    firstInboundAt: data.firstInboundAt || null,
    lastInboundAt:
      data.lastInboundAt ||
      (cleanString(data.lastMessageDirection || data.lastFrom).toLowerCase() === "in"
        ? data.lastMessageAt || null
        : null),
    firstSellerResponseAt: data.firstSellerResponseAt || data.firstEverSellerResponseAt || null,
    lastSellerResponseAt: data.lastSellerResponseAt || null,
    firstResponseTimeSeconds: Number.isFinite(firstResponseSeconds) ? firstResponseSeconds : null,
    lastResponseTimeSeconds: Number.isFinite(Number(data.lastResponseTimeSeconds))
      ? Number(data.lastResponseTimeSeconds)
      : null,
    inboundMessageCount: Number(data.inboundMessageCount ?? data.inboundMessagesCount ?? 0),
    sellerResponseCount: Number(data.sellerResponseCount ?? 0),
    responseSource: cleanString(data.responseSource, 80) || null,
    responseConfirmation: cleanString(data.responseConfirmation, 80) || null,
    hasConfirmedResponse: responseIsConfirmed(data),
    manualAttentionAt: data.manualAttentionAt || null,
    chatbotStatus: cleanString(data.chatbotStatus, 80) || null,
    chatbotTransferStatus: cleanString(data.chatbotTransferStatus, 80) || null,
    chatbotTransferReason: cleanString(data.chatbotTransferReason, 120) || null,
    chatbotTransferredAt: data.chatbotTransferredAt || null,
    chatbotHumanActiveAt: data.chatbotHumanActiveAt || null,
    chatbotTakenAt: data.chatbotTakenAt || null,
    chatbotTakenByEmail: normalizeEmail(data.chatbotTakenByEmail) || null,
    chatbotReactivatedAt: data.chatbotReactivatedAt || null,
    chatbotReactivatedByEmail: normalizeEmail(data.chatbotReactivatedByEmail) || null,
    chatbotFlowId: cleanString(data.chatbotFlowId, 160) || null,
    chatbotFlowVersion: Number(data.chatbotFlowVersion) || null,
    chatbotCurrentQuestionId: cleanString(data.chatbotCurrentQuestionId, 160) || null,
    chatbotFormCompleted: data.chatbotFormCompleted === true,
    chatbotOrderConfirmed: data.chatbotOrderConfirmed === true,
    chatbotOrderId: cleanString(data.chatbotOrderId, 160) || null,
    chatbotOrderConfirmedAt: data.chatbotOrderConfirmedAt || null,
    chatbotLastSessionRevision: Math.max(0, Number(data.chatbotLastSessionRevision) || 0),
    chatbotAnswers,
    chatbotProduct: chatbotAnswer("product", "producto", "service", "servicio", "need", "consulta"),
    chatbotQuantity: chatbotAnswer("quantity", "cantidad", "units", "unidades"),
    chatbotLocality: chatbotAnswer("locality", "localidad", "city", "ciudad"),
    chatbotAddress: chatbotAnswer("address", "direccion", "dirección", "domicilio"),
    source: getSource(data),
    campaign: getCampaign(data) || null,
    labels: Array.isArray(data.labels) ? data.labels.map((value) => cleanString(value, 120)).filter(Boolean) : [],
    internalNote: cleanString(data.internalNote || data.lastInternalNote, 4000) || null,
    followUpAt: followUp.at,
    followUpNote: followUp.note || null,
    followUpCompleted: followUp.completed,
    followUpCompletedAt: followUp.completedAt,
    sold: normalizedStatus(data) === "vendido" || data.sold === true,
    soldAt: data.soldAt || data.saleAt || null,
    noInterestReason: cleanString(data.noInterestReason || data.motivoNoInteres, 1000) || null,
    lastMessageAt: data.lastMessageAt || data.updatedAt || null,
    lastMessageText: cleanString(data.lastMessageText || data.lastInboundPreview, 500),
    lastMessageDirection: cleanString(data.lastMessageDirection || data.lastFrom, 30),
    updatedAt: data.updatedAt || null,
    createdAt: data.createdAt || null,
    claimable,
  };
}

function serialize(value) {
  if (value == null) return value;
  const date = toDate(value);
  if (
    date &&
    (value instanceof Date || typeof value?.toDate === "function" || typeof value?.toMillis === "function")
  ) {
    return date.toISOString();
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = serialize(item);
    return out;
  }
  return value;
}

function publicMessage(id, data = {}) {
  // Los snapshots crudos siguen almacenados para diagnóstico, pero no se
  // envían al navegador: pueden ser grandes y no son necesarios para gestionar.
  const {
    raw: _raw,
    rawEcho: _rawEcho,
    rawResponse: _rawResponse,
    rawWebhookSnapshot: _rawWebhookSnapshot,
    ...safe
  } = data;
  return { id, ...safe };
}

function configuredAdminEmails() {
  const extra = String(process.env.CRM_ADMIN_EMAILS || process.env.PURGE_ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  return new Set([...DEFAULT_ADMIN_EMAILS, ...extra]);
}

export async function authenticateCrmRequest(req) {
  const header = String(req?.headers?.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    const error = new Error("Falta el token de Firebase");
    error.statusCode = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    const error = new Error("Token de Firebase inválido");
    error.statusCode = 401;
    throw error;
  }

  const uid = cleanString(decoded.uid);
  const email = normalizeEmail(decoded.email);
  const profileSnap = uid ? await db.collection("users").doc(uid).get().catch(() => null) : null;
  const profile = profileSnap?.exists ? profileSnap.data() || {} : {};
  const claimRole = cleanString(decoded.role).toLowerCase();
  const isAdmin = Boolean(
    decoded.admin === true ||
      decoded.isAdmin === true ||
      decoded.supervisor === true ||
      claimRole === "admin" ||
      claimRole === "supervisor" ||
      configuredAdminEmails().has(email)
  );

  let hasSellerAccess = profileSnap?.exists === true;
  if (!isAdmin && !hasSellerAccess) {
    const [byUid, byEmail] = await Promise.all([
      db.collection("wabaNumbers").where("ownerUid", "==", uid).limit(1).get().catch(() => null),
      db.collection("wabaNumbers").where("owner", "==", email).limit(1).get().catch(() => null),
    ]);
    hasSellerAccess = Boolean(byUid?.size || byEmail?.size);
  }

  if (!uid || !email || (!isAdmin && (!hasSellerAccess || profile.active === false))) {
    const error = new Error("Usuario sin acceso al CRM");
    error.statusCode = 403;
    throw error;
  }

  return {
    uid,
    email,
    name: cleanString(decoded.name || profile.name || profile.alias || email, 200),
    role: isAdmin ? "admin" : "seller",
    isAdmin,
  };
}

export function getCrmEventRef(eventKey) {
  return db.collection("gestionEventos").doc(sanitizeEventId(eventKey));
}

export function buildInboundCrmPatch({ data = {}, isNew, occurredAt, message, value }) {
  const eventDate = toDate(occurredAt) || new Date();
  const previousStatus = normalizedStatus(data);
  const pendingDate = toDate(data.pendingSinceAt);
  const lastResponseDate = toDate(data.lastSellerResponseAt);
  const hasOpenPendingCycle = Boolean(
    pendingDate && (!lastResponseDate || pendingDate.getTime() > lastResponseDate.getTime())
  );
  const startsPendingCycle = Boolean(isNew || !hasOpenPendingCycle || TERMINAL_OR_ATTENDED.has(previousStatus));
  const referral = message?.referral || null;
  const source = referral?.source_type || referral?.sourceType || (isNew ? "directo" : null);
  const campaign = referral?.headline || referral?.source_id || referral?.sourceId || null;
  const patch = {
    gestionStatus: isNew ? "nuevo" : startsPendingCycle ? "pendiente" : previousStatus,
    lastInboundAt: timestamp(eventDate),
    inboundMessageCount: FieldValue.increment(1),
    crmUpdatedAt: FieldValue.serverTimestamp(),
  };

  if (!data.firstInboundAt) patch.firstInboundAt = timestamp(eventDate);
  if (startsPendingCycle) {
    patch.pendingSinceAt = timestamp(eventDate);
    patch.currentCycleResponseAt = null;
    patch.currentCycleManualAt = null;
    patch.responseConfirmation = null;
    patch.responseSource = null;
    patch.lastResponseTimeSeconds = null;
    patch.manualAttentionAt = null;
    patch.manualAttentionBy = null;
  }
  if (source && !data.leadSource) patch.leadSource = cleanString(source, 120).toLowerCase();
  if (campaign && !data.campaign) patch.campaign = cleanString(campaign, 500);
  if (referral) {
    if (!data.firstReferral) patch.firstReferral = referral;
    patch.lastReferral = referral;
  }
  if (value?.metadata?.phone_number_id) {
    patch.businessPhoneId = cleanString(value.metadata.phone_number_id, 120);
  }
  return { patch, startsPendingCycle };
}

export function buildInboundEvent({
  eventKey,
  conversationId,
  contactPhone,
  message,
  value,
  isNew,
  assignedToUid,
  assignedToEmail,
  occurredAt,
}) {
  const referral = message?.referral || null;
  return {
    id: sanitizeEventId(eventKey),
    conversationId,
    contactId: contactPhone,
    type: isNew ? "contact_created" : "inbound_message",
    occurredAt: timestamp(occurredAt),
    createdAt: FieldValue.serverTimestamp(),
    actorUid: null,
    actorEmail: null,
    sellerUid: assignedToUid || null,
    sellerEmail: normalizeEmail(assignedToEmail) || null,
    messageId: message?.id || null,
    wabaPhoneId: value?.metadata?.phone_number_id || null,
    source: referral?.source_type || referral?.sourceType || (isNew ? "directo" : null),
    campaign: referral?.headline || referral?.source_id || referral?.sourceId || null,
    metadata: {
      messageType: message?.type || "unknown",
      webhookField: "messages",
    },
  };
}

export function parseSmbMessageEcho(value, echo) {
  if (!echo) return null;
  const phoneId = cleanString(value?.metadata?.phone_number_id || echo?.phone_number_id, 120);
  const phone = normalizeE164AR(echo?.to || echo?.recipient_id || echo?.recipient?.wa_id || "");
  const messageId = cleanString(echo?.id || echo?.message_id, 700);
  if (!phoneId || !phone || !messageId) return null;
  const occurredAt = echo.timestamp
    ? new Date(Number(echo.timestamp) * 1000)
    : new Date();
  return {
    phoneId,
    phone,
    messageId,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    type: cleanString(echo.type || "text", 80).toLowerCase() || "text",
    text: cleanString(echo?.text?.body || echo?.body || echo?.caption, 4000),
    raw: echo,
  };
}

function buildSellerResponseMutation({ data = {}, eventDate, sourceValue, actorEmail }) {
  const occurredAt = toDate(eventDate) || new Date();
  const pendingDate = toDate(data.pendingSinceAt || data.firstInboundAt);
  const lastResponseDate = toDate(data.lastSellerResponseAt);
  const hasOpenPendingCycle = Boolean(
    pendingDate &&
      pendingDate.getTime() <= occurredAt.getTime() &&
      (!lastResponseDate || pendingDate.getTime() > lastResponseDate.getTime())
  );
  const responseSeconds = hasOpenPendingCycle
    ? Math.max(0, Math.floor((occurredAt.getTime() - pendingDate.getTime()) / 1000))
    : null;
  const responseTs = timestamp(occurredAt);
  const existingFirstResponse = data.firstSellerResponseAt || data.firstEverSellerResponseAt;
  const patch = {
    lastSellerResponseAt: responseTs,
    outboundMessageCount: FieldValue.increment(1),
    lastOutboundSource: sourceValue,
    crmUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (hasOpenPendingCycle) {
    patch.currentCycleResponseAt = responseTs;
    patch.sellerResponseCount = FieldValue.increment(1);
    patch.responseSource = sourceValue;
    patch.responseConfirmation = sourceValue === "cloud_api" ? "cloud_api" : "webhook";
    patch.gestionStatus = "atendido";
    patch.gestionStatusUpdatedAt = FieldValue.serverTimestamp();
    patch.gestionStatusUpdatedBy =
      sourceValue === "cloud_api"
        ? normalizeEmail(actorEmail) || "system:cloud_api"
        : "system:webhook";
  }
  if (hasOpenPendingCycle && !existingFirstResponse) {
    patch.firstSellerResponseAt = responseTs;
    patch.firstResponseTimeSeconds = responseSeconds;
  }
  if (responseSeconds != null) patch.lastResponseTimeSeconds = responseSeconds;
  return { patch, responseSeconds, hasOpenPendingCycle, responseTs };
}

export async function recordConfirmedSellerResponse({
  conversationId,
  phone,
  phoneId,
  messageId,
  occurredAt = new Date(),
  source,
  actorUid = null,
  actorEmail = null,
  type = "text",
  text = "",
  raw = null,
  metadataOnly = false,
}) {
  let resolvedId = cleanString(conversationId, 900);
  if (!resolvedId) {
    const context = await resolveConversationContext(db, {
      rawPhone: phone,
      phoneId,
      preferScopedId: true,
    });
    resolvedId = cleanString(context?.conversationId, 900);
  }
  if (!resolvedId || !messageId) return { ignored: true, reason: "conversation_or_message_missing" };

  const sourceValue = source === "whatsapp_business_app" ? source : "cloud_api";
  const eventKey = `${sourceValue === "whatsapp_business_app" ? "meta_echo" : "cloud_out"}_${messageId}`;
  const eventRef = getCrmEventRef(eventKey);
  const convRef = db.collection("conversations").doc(resolvedId);
  const msgRef = convRef.collection("messages").doc(messageId);
  const eventDate = toDate(occurredAt) || new Date();

  return db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) return { duplicate: true, conversationId: resolvedId };

    const convSnap = await tx.get(convRef);
    if (!convSnap.exists) return { ignored: true, reason: "conversation_not_found" };
    const data = convSnap.data() || {};
    const { patch, responseSeconds, hasOpenPendingCycle, responseTs } =
      buildSellerResponseMutation({ data, eventDate, sourceValue, actorEmail });
    const preview = text || (type !== "text" ? `[${type}]` : "Respuesta del vendedor");

    tx.set(convRef, patch, { merge: true });
    if (!metadataOnly) tx.set(
      msgRef,
      {
        direction: "out",
        from: "agent",
        type: type || "text",
        ...(text ? { text } : {}),
        timestamp: responseTs,
        status: "sent",
        businessPhoneId: phoneId || getConversationPhoneId(data) || null,
        source: sourceValue,
        responseConfirmed: hasOpenPendingCycle,
        ...(raw ? { rawEcho: raw } : {}),
      },
      { merge: true }
    );
    tx.create(eventRef, {
      conversationId: resolvedId,
      contactId: conversationPhone(data) || phone || null,
      type: hasOpenPendingCycle ? "seller_response" : "outbound_message",
      occurredAt: responseTs,
      createdAt: FieldValue.serverTimestamp(),
      actorUid: actorUid || null,
      actorEmail: normalizeEmail(actorEmail) || null,
      sellerUid: data.assignedToUid || actorUid || null,
      sellerEmail: normalizeEmail(data.assignedToEmail || actorEmail) || null,
      messageId,
      wabaPhoneId: phoneId || getConversationPhoneId(data) || null,
      responseSource: sourceValue,
      responseConfirmation: sourceValue === "cloud_api" ? "cloud_api" : "webhook",
      responseTimeSeconds: responseSeconds,
      ...(metadataOnly ? {} : { preview: cleanString(preview, 500) }),
      metadata: { webhookField: sourceValue === "whatsapp_business_app" ? "smb_message_echoes" : null },
    });
    return {
      duplicate: false,
      conversationId: resolvedId,
      responseTimeSeconds: responseSeconds,
      hasOpenPendingCycle,
    };
  });
}

async function loadWabaRows() {
  const snap = await db.collection("wabaNumbers").get();
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function loadAccessibleRows(actor, wabaRows) {
  const actorPhoneIds = getActorPhoneIds(actor, wabaRows);
  const wabaMap = buildWabaMap(wabaRows);
  let documents = [];
  let truncated = false;
  if (actor.isAdmin) {
    const pageSize = 2000;
    const scanLimit = 25000;
    let cursor = null;
    do {
      let query = db
        .collection("conversations")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      documents.push(...snapshot.docs);
      cursor = snapshot.docs.at(-1) || null;
      if (snapshot.size < pageSize) break;
      if (documents.length >= scanLimit) {
        truncated = true;
        break;
      }
    } while (cursor);
    documents = documents.slice(0, scanLimit);
  } else {
    const queryLimit = 10000;
    const querySpecs = [
      ["assignedToUid", actor.uid],
      ["assignedToEmail", actor.email],
    ];
    for (const phoneId of actorPhoneIds) {
      for (const field of ["scopedPhoneNumberId", "lastInboundPhoneId", "businessPhoneId", "waPhoneId"]) {
        querySpecs.push([field, phoneId]);
      }
    }
    const snapshots = await Promise.all(
      querySpecs.map(([field, value]) =>
        db.collection("conversations").where(field, "==", value).limit(queryLimit).get()
      )
    );
    const byId = new Map();
    for (const snapshot of snapshots) {
      if (snapshot.size >= queryLimit) truncated = true;
      for (const docSnap of snapshot.docs) byId.set(docSnap.id, docSnap);
    }
    documents = [...byId.values()];
  }

  const rows = [];
  for (const docSnap of documents) {
    const data = docSnap.data() || {};
    const claimable = canClaim(actor, data, actorPhoneIds);
    if (!canReadConversation(actor, data, actorPhoneIds)) continue;
    rows.push(publicConversation(docSnap.id, data, {}, wabaMap, claimable));
  }
  rows.sort((a, b) => toMillisMaybe(b.lastInboundAt || b.lastMessageAt) - toMillisMaybe(a.lastInboundAt || a.lastMessageAt));
  return { rows, actorPhoneIds, wabaMap, scannedCount: documents.length, truncated };
}

async function loadEvents(range) {
  let query = db.collection("gestionEventos").orderBy("occurredAt", "desc");
  if (range.start) query = query.where("occurredAt", ">=", timestamp(range.start));
  if (range.end) query = query.where("occurredAt", "<", timestamp(range.end));
  const snapshot = await query.limit(10000).get().catch(async () => {
    const fallback = await db.collection("gestionEventos").limit(10000).get();
    return fallback;
  });
  const events = snapshot.docs
    .map((item) => ({ id: item.id, ...(item.data() || {}) }))
    .filter((event) => inRange(event.occurredAt || event.createdAt, range.start, range.end))
    .sort((a, b) => toMillisMaybe(b.occurredAt || b.createdAt) - toMillisMaybe(a.occurredAt || a.createdAt));
  return { events, truncated: snapshot.size >= 10000 };
}

function matchesFilter(row, filters, range) {
  const firstIn = inRange(row.firstInboundAt, range.start, range.end);
  const lastIn = inRange(row.lastInboundAt || row.lastMessageAt, range.start, range.end);
  if ((range.start || range.end) && !firstIn && !lastIn) return false;
  if (filters.seller && filters.seller !== "all") {
    const seller = cleanString(filters.seller);
    if (row.assignedToUid !== seller && row.assignedToEmail !== normalizeEmail(seller)) return false;
  }
  if (filters.zone && filters.zone !== "all" && row.zone !== filters.zone) return false;
  if (filters.customerZone && filters.customerZone !== "all" && (row.crmCustomerZone || "Sin identificar") !== filters.customerZone) return false;
  if (filters.qualification && filters.qualification !== "all" && (row.crmQualification || "Sin clasificar") !== filters.qualification) return false;
  if (filters.commercialOutcome && filters.commercialOutcome !== "all" && (row.crmOutcome || "Sin clasificar") !== filters.commercialOutcome) return false;
  if (filters.status && filters.status !== "all" && row.gestionStatus !== filters.status) return false;
  if (filters.waba && filters.waba !== "all" && row.wabaPhoneId !== cleanString(filters.waba)) return false;
  if (filters.source && filters.source !== "all" && row.source !== cleanString(filters.source).toLowerCase()) return false;
  if (filters.campaign && filters.campaign !== "all" && row.campaign !== filters.campaign) return false;
  if (filters.response === "with" && !row.hasConfirmedResponse && !row.manualAttentionAt) return false;
  if (filters.response === "without" && (row.hasConfirmedResponse || row.manualAttentionAt)) return false;
  if (filters.sold === "sold" && !row.sold) return false;
  if (filters.sold === "not_sold" && row.sold) return false;
  const overdue = !row.followUpCompleted && toMillisMaybe(row.followUpAt) > 0 && toMillisMaybe(row.followUpAt) < Date.now();
  if (filters.overdue === true && !overdue) return false;
  return true;
}

function groupCount(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = cleanString(keyFn(row), 500) || "Sin dato";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function percentileMedian(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildMetrics(rows, events, range) {
  const now = Date.now();
  const inboundEvents = events.filter((event) => ["contact_created", "inbound_message"].includes(event.type));
  const responseEvents = events.filter(
    (event) => event.type === "seller_response" && Number.isFinite(Number(event.responseTimeSeconds))
  );
  const responseTimes = responseEvents.map((event) => Number(event.responseTimeSeconds));
  const conversationsWithMeasuredEvent = new Set(responseEvents.map((event) => event.conversationId));
  for (const row of rows) {
    if (
      !conversationsWithMeasuredEvent.has(row.id) &&
      Number.isFinite(Number(row.firstResponseTimeSeconds)) &&
      inRange(row.firstSellerResponseAt, range.start, range.end)
    ) {
      responseTimes.push(Number(row.firstResponseTimeSeconds));
    }
  }
  const newContacts = rows.filter((row) => inRange(row.firstInboundAt, range.start, range.end));
  const returning = rows.filter((row) => {
    const first = toMillisMaybe(row.firstInboundAt);
    return Boolean(range.start && first && first < range.start.getTime() && inRange(row.lastInboundAt, range.start, range.end));
  });
  const statuses = Object.fromEntries(CRM_STATUSES.map((status) => [status, 0]));
  for (const row of rows) statuses[row.gestionStatus] = (statuses[row.gestionStatus] || 0) + 1;
  const confirmed = rows.filter((row) => row.hasConfirmedResponse).length;
  const manual = rows.filter((row) => !row.hasConfirmedResponse && row.manualAttentionAt).length;
  const manageable = rows.filter((row) => row.gestionStatus !== "numero_incorrecto").length;
  const followUps = rows.filter((row) => row.followUpAt && !row.followUpCompleted);
  const overdue = followUps.filter((row) => toMillisMaybe(row.followUpAt) < now);
  const todayKey = argentinaDayKey(new Date(now));
  const followUpToday = followUps.filter((row) => argentinaDayKey(row.followUpAt) === todayKey);
  const sold = rows.filter((row) => row.sold).length;
  const under5 = responseTimes.filter((value) => value < 300).length;
  const under15 = responseTimes.filter((value) => value < 900).length;
  const under60 = responseTimes.filter((value) => value < 3600).length;
  const sum = responseTimes.reduce((total, value) => total + value, 0);
  const chatbotRows = rows.filter((row) => row.chatbotStatus || row.chatbotFlowId);
  const chatbotTransfers = chatbotRows.filter((row) => row.chatbotTransferredAt);
  const chatbotHumanResponseTimes = chatbotTransfers.map((row) => {
    const start = toMillisMaybe(row.chatbotTransferredAt);
    const end = toMillisMaybe(row.firstSellerResponseAt);
    return start > 0 && end >= start ? (end - start) / 1000 : null;
  }).filter(Number.isFinite);
  const abandonmentCutoff = now - (24 * 60 * 60 * 1000);
  const chatbotAbandoned = chatbotRows.filter((row) => row.chatbotStatus === "WAITING_FOR_CUSTOMER" && !row.chatbotTransferredAt && toMillisMaybe(row.lastInboundAt) < abandonmentCutoff);
  return {
    contactsReceived: newContacts.length,
    uniqueContacts: new Set(rows.map((row) => digits(row.phone)).filter(Boolean)).size,
    contactsInPeriod: rows.length,
    returningContacts: returning.length,
    inboundMessages: inboundEvents.length || ((range.start || range.end) ? 0 : rows.reduce((total, row) => total + row.inboundMessageCount, 0)),
    attended: statuses.atendido + sold,
    confirmedResponses: confirmed,
    manualAttentions: manual,
    attentionRate: manageable ? ((confirmed + manual) / manageable) * 100 : 0,
    pending: statuses.nuevo + statuses.pendiente,
    withoutResponse: rows.filter((row) => !row.hasConfirmedResponse && !row.manualAttentionAt).length,
    followUp: followUps.length,
    followUpToday: followUpToday.length,
    overdueFollowUp: overdue.length,
    completedFollowUp: events.filter((event) => event.type === "follow_up_completed").length,
    sold,
    conversionRate: manageable ? (sold / manageable) * 100 : 0,
    noAnswer: statuses.no_contesto,
    noInterest: statuses.no_interesa,
    wrongNumber: statuses.numero_incorrecto,
    unassigned: rows.filter((row) => !row.assignedToUid && !row.assignedToEmail).length,
    responseAverageSeconds: responseTimes.length ? sum / responseTimes.length : null,
    responseMedianSeconds: percentileMedian(responseTimes),
    responseMaxSeconds: responseTimes.length ? Math.max(...responseTimes) : null,
    responseSamples: responseTimes.length,
    responseUnder5Percent: responseTimes.length ? (under5 / responseTimes.length) * 100 : null,
    responseUnder15Percent: responseTimes.length ? (under15 / responseTimes.length) * 100 : null,
    responseUnder60Percent: responseTimes.length ? (under60 / responseTimes.length) * 100 : null,
    responseDistribution: {
      under5,
      from5To15: responseTimes.filter((value) => value >= 300 && value < 900).length,
      from15To60: responseTimes.filter((value) => value >= 900 && value < 3600).length,
      over60: responseTimes.filter((value) => value >= 3600).length,
    },
    responseSources: {
      whatsappBusiness: events.filter((event) => event.type === "seller_response" && event.responseSource === "whatsapp_business_app").length,
      cloudApi: events.filter((event) => event.type === "seller_response" && event.responseSource === "cloud_api").length,
      manual,
    },
    chatbot: {
      contacts: chatbotRows.length,
      formsCompleted: chatbotRows.filter((row) => row.chatbotFormCompleted).length,
      ordersConfirmedByCustomer: chatbotRows.filter((row) => row.chatbotOrderConfirmed).length,
      transfers: chatbotTransfers.length,
      pendingHuman: chatbotTransfers.filter((row) => !row.firstSellerResponseAt).length,
      earlyHumanRequests: chatbotTransfers.filter((row) => row.chatbotTransferReason === "CUSTOMER_REQUESTED_HUMAN").length,
      failures: chatbotTransfers.filter((row) => ["SEND_ERROR", "MAX_ATTEMPTS", "MESSAGE_LIMIT"].includes(row.chatbotTransferReason)).length,
      abandoned: chatbotAbandoned.length,
      sold: chatbotRows.filter((row) => row.sold).length,
      conversionRate: chatbotRows.length ? (chatbotRows.filter((row) => row.sold).length / chatbotRows.length) * 100 : 0,
      averageTimeToHumanSeconds: chatbotHumanResponseTimes.length ? chatbotHumanResponseTimes.reduce((sumValue, value) => sumValue + value, 0) / chatbotHumanResponseTimes.length : null,
      responseSamples: chatbotHumanResponseTimes.length,
    },
    statuses,
  };
}

function buildVendorPerformance(rows, events, vendors) {
  const bySeller = new Map();
  const ensure = (key, seed = {}) => {
    if (!bySeller.has(key)) {
      bySeller.set(key, {
        key,
        uid: seed.uid || null,
        email: seed.email || null,
        name: seed.name || seed.email || key,
        assigned: 0,
        attended: 0,
        pending: 0,
        followUp: 0,
        overdue: 0,
        sold: 0,
        newContacts: 0,
        recurring: 0,
        qualified: 0,
        budgets: 0,
        lost: 0,
        ghosts: 0,
        frozen: 0,
        verifiedResponses: 0,
        manualAttentions: 0,
        chatbotTransfers: 0,
        chatbotSales: 0,
        responseTimes: [],
        lastActivityAt: null,
      });
    }
    return bySeller.get(key);
  };

  for (const vendor of vendors) {
    const key = vendor.uid || vendor.email;
    if (key) ensure(key, vendor);
  }
  const groupedRows = new Map();
  for (const row of rows) {
    const sellerKey = row.assignedToUid || row.assignedToEmail || "unassigned";
    const leadKey = digits(row.phone) || row.id;
    const groupKey = `${sellerKey}:${leadKey}`;
    const current = groupedRows.get(groupKey);
    if (current) current.conversationCount += 1;
    else groupedRows.set(groupKey, { row, conversationCount: 1 });
  }
  for (const { row, conversationCount } of groupedRows.values()) {
    const key = row.assignedToUid || row.assignedToEmail || "unassigned";
    const item = ensure(key, {
      uid: row.assignedToUid,
      email: row.assignedToEmail,
      name: row.assignedToName || row.assignedToEmail || "Sin asignar",
    });
    item.assigned += 1;
    if (conversationCount > 1 || Number(row.inboundMessageCount || 0) > 1) item.recurring += 1;
    else item.newContacts += 1;
    if (row.crmQualification === "Calificado") item.qualified += 1;
    if (optionalNumber(row.crmQuoteAmount) !== null) item.budgets += 1;
    if (row.crmOutcome === "Vendido") item.sold += 1;
    if (row.chatbotTransferredAt) item.chatbotTransfers += 1;
    if (row.chatbotTransferredAt && row.sold) item.chatbotSales += 1;
    if (row.crmOutcome === "Perdido") item.lost += 1;
    if (row.crmOutcome === "Fantasma") item.ghosts += 1;
    if (row.crmOutcome === "Congelado") item.frozen += 1;
    if (row.gestionStatus === "atendido" || row.sold) item.attended += 1;
    if (["nuevo", "pendiente"].includes(row.gestionStatus)) item.pending += 1;
    if (row.followUpAt && !row.followUpCompleted) item.followUp += 1;
    if (row.followUpAt && !row.followUpCompleted && toMillisMaybe(row.followUpAt) < Date.now()) item.overdue += 1;
    if (row.hasConfirmedResponse) item.verifiedResponses += 1;
    if (!row.hasConfirmedResponse && row.manualAttentionAt) item.manualAttentions += 1;
    const activity = toMillisMaybe(row.lastInboundAt || row.lastMessageAt);
    if (activity > toMillisMaybe(item.lastActivityAt)) item.lastActivityAt = row.lastInboundAt || row.lastMessageAt;
  }
  for (const event of events) {
    if (event.type !== "seller_response" || !Number.isFinite(Number(event.responseTimeSeconds))) continue;
    const key = cleanString(event.sellerUid || event.sellerEmail || "unassigned");
    ensure(key).responseTimes.push(Number(event.responseTimeSeconds));
  }
  return [...bySeller.values()]
    .filter((item) => item.assigned > 0)
    .map((item) => ({
      ...item,
      conversionRate: item.qualified ? (item.sold / item.qualified) * 100 : null,
      averageResponseSeconds: item.responseTimes.length
        ? item.responseTimes.reduce((sum, value) => sum + value, 0) / item.responseTimes.length
        : null,
      under15Percent: item.responseTimes.length
        ? (item.responseTimes.filter((value) => value < 900).length / item.responseTimes.length) * 100
        : null,
      responseTimes: undefined,
    }))
    .sort((a, b) => b.assigned - a.assigned);
}

function sanitizeVendorRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const uid = cleanString(row.ownerUid || row.userUid);
    const email = normalizeEmail(row.owner || row.ownerEmail || row.email);
    const key = uid || email;
    if (!key) continue;
    const current = seen.get(key) || { uid: uid || null, email: email || null, phoneIds: [] };
    const phoneId = cleanString(row.waPhoneId || row.phoneId || row.phoneNumberId || row.id);
    if (phoneId && !current.phoneIds.includes(phoneId)) current.phoneIds.push(phoneId);
    current.name = cleanString(row.alias || row.name || current.name || email || uid, 200);
    current.zone = cleanString(row.zone || current.zone, 160) || "Sin zona";
    current.active = current.active !== false && row.active !== false;
    seen.set(key, current);
  }
  return [...seen.values()].filter((row) => row.active !== false);
}

export async function getCrmDashboard(actor, filters = {}) {
  const wabaRows = await loadWabaRows();
  const vendors = sanitizeVendorRows(wabaRows);
  const { rows, scannedCount, truncated: conversationsTruncated } = await loadAccessibleRows(actor, wabaRows);
  const range = parseRange(filters);
  const filtered = rows.filter((row) => matchesFilter(row, filters, range));
  const metricRows = actor.isAdmin ? filtered : filtered.filter((row) => !row.claimable);
  const allowedIds = new Set(metricRows.map((row) => row.id));
  const loadedEvents = await loadEvents(range);
  const events = loadedEvents.events.filter((event) => allowedIds.has(event.conversationId));
  const metrics = buildMetrics(metricRows, events, range);
  const zonePhones = groupUniqueZonePhones(metricRows);
  const excelAnalytics = buildExcelAnalytics(metricRows);
  const critical = metricRows
    .filter((row) => {
      const waiting = Date.now() - toMillisMaybe(row.lastInboundAt || row.firstInboundAt);
      const overdue = row.followUpAt && !row.followUpCompleted && toMillisMaybe(row.followUpAt) < Date.now();
      return (
        overdue ||
        (!row.assignedToUid && !row.assignedToEmail) ||
        (!row.hasConfirmedResponse && waiting > 3600000)
      );
    })
    .slice(0, 40);
  const responseEventCount = events.filter((event) => event.type === "seller_response").length;

  return serialize({
    role: actor.role,
    generatedAt: new Date(),
    range,
    metrics,
    excelAnalytics,
    customerZoneSummary: {
      uniqueNumbers: zonePhones.uniqueNumbers,
      withoutPhone: zonePhones.withoutPhone,
      identifiedNumbers: zonePhones.summary.filter((r) => !["Sin identificar", "Zona por revisar"].includes(r.key)).reduce((sum, r) => sum + r.uniqueNumbers, 0),
    },
    contacts: filtered.slice(0, 500),
    criticalContacts: critical,
    recentActivity: events.slice(0, 100),
    breakdowns: {
      status: groupCount(metricRows, (row) => row.gestionStatus),
      seller: groupCount(metricRows, (row) => row.assignedToName || row.assignedToEmail || "Sin asignar"),
      zone: groupCount(metricRows, (row) => row.zone), // zona operativa WABA
      customerZone: zonePhones.summary,
      source: groupCount(metricRows, (row) => row.source),
      campaign: groupCount(metricRows.filter((row) => row.campaign), (row) => row.campaign),
      labels: groupCount(metricRows.flatMap((row) => row.labels.map((label) => ({ label }))), (row) => row.label),
      salesByZone: groupCount(metricRows.filter((row) => row.sold), (row) => row.zone),
      salesBySource: groupCount(metricRows.filter((row) => row.sold), (row) => row.source),
      salesByCampaign: groupCount(metricRows.filter((row) => row.sold && row.campaign), (row) => row.campaign),
      salesByLabel: groupCount(
        metricRows.filter((row) => row.sold).flatMap((row) => row.labels.map((label) => ({ label }))),
        (row) => row.label
      ),
      chatbotAbandonmentQuestion: groupCount(
        metricRows.filter((row) => row.chatbotStatus === "WAITING_FOR_CUSTOMER" && !row.chatbotTransferredAt && toMillisMaybe(row.lastInboundAt) < Date.now() - (24 * 60 * 60 * 1000)),
        (row) => row.chatbotCurrentQuestionId || "Sin identificar"
      ),
      chatbotTransferReason: groupCount(metricRows.filter((row) => row.chatbotTransferredAt), (row) => row.chatbotTransferReason || "Sin identificar"),
      chatbotResponsibleSeller: groupCount(metricRows.filter((row) => row.chatbotTransferredAt), (row) => row.assignedToName || row.assignedToEmail || "Sin asignar"),
    },
    vendorPerformance: buildVendorPerformance(metricRows, events, vendors),
    options: {
      vendors,
      zones: [...new Set(rows.map((row) => row.zone).filter(Boolean))].sort(),
      customerZones: [...new Set(rows.map((row) => row.crmCustomerZone).filter(Boolean))].sort(),
      wabaNumbers: [...new Set(rows.map((row) => row.wabaPhoneId).filter(Boolean))].sort(),
      sources: [...new Set(rows.map((row) => row.source).filter(Boolean))].sort(),
      campaigns: [...new Set(rows.map((row) => row.campaign).filter(Boolean))].sort(),
      statuses: CRM_STATUSES,
    },
    coverage: {
      eventBased: events.length > 0,
      scannedConversations: scannedCount,
      conversationsTruncated,
      eventsTruncated: loadedEvents.truncated,
      inboundEvents: events.filter((event) => ["contact_created", "inbound_message"].includes(event.type)).length,
      responseEvents: responseEventCount,
      note:
        events.length > 0
          ? "Mensajes y respuestas exactos se miden desde la activación de Gestión CRM."
          : "No hay eventos nuevos en el período; solo se muestran datos históricos reconstruibles desde conversations.",
    },
  });
}

async function getConversationAccess(actor, conversationId, { requireManage = false } = {}) {
  const id = cleanString(conversationId, 900);
  if (!id) {
    const error = new Error("Falta conversationId");
    error.statusCode = 400;
    throw error;
  }
  const [convSnap, wabaRows] = await Promise.all([
    db.collection("conversations").doc(id).get(),
    loadWabaRows(),
  ]);
  if (!convSnap.exists) {
    const error = new Error("Conversación inexistente");
    error.statusCode = 404;
    throw error;
  }
  const data = convSnap.data() || {};
  const actorPhoneIds = getActorPhoneIds(actor, wabaRows);
  const allowed = requireManage
    ? canManageConversation(actor, data)
    : canReadConversation(actor, data, actorPhoneIds);
  if (!allowed) {
    const error = new Error("No tenés permiso sobre esta conversación");
    error.statusCode = 403;
    throw error;
  }
  return { id, ref: convSnap.ref, data, wabaRows, wabaMap: buildWabaMap(wabaRows), actorPhoneIds };
}

export async function getCrmContactDetail(actor, conversationId) {
  const access = await getConversationAccess(actor, conversationId);
  const phone = conversationPhone(access.data);
  const contactRefs = [
    db.collection("contacts").doc(access.id),
    ...(phone && phone !== access.id ? [db.collection("contacts").doc(phone)] : []),
  ];
  const [messageSnap, noteSnap, eventSnap, ...contactSnaps] = await Promise.all([
    access.ref.collection("messages").orderBy("timestamp", "desc").limit(300).get().catch(() => access.ref.collection("messages").limit(300).get()),
    access.ref.collection("notes").orderBy("createdAt", "desc").limit(100).get().catch(() => access.ref.collection("notes").limit(100).get()),
    db.collection("gestionEventos").where("conversationId", "==", access.id).limit(500).get(),
    ...contactRefs.map((ref) => ref.get().catch(() => null)),
  ]);
  const contactSnap = contactSnaps.find((snap) => snap?.exists);
  const contact = contactSnap?.exists ? { id: contactSnap.id, ...(contactSnap.data() || {}) } : {};
  const messages = messageSnap.docs
    .map((docSnap) => publicMessage(docSnap.id, docSnap.data() || {}))
    .sort((a, b) => toMillisMaybe(a.timestamp || a.createdAt) - toMillisMaybe(b.timestamp || b.createdAt));
  const notes = noteSnap.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .sort((a, b) => toMillisMaybe(b.createdAt) - toMillisMaybe(a.createdAt));
  const events = eventSnap.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .sort((a, b) => toMillisMaybe(b.occurredAt || b.createdAt) - toMillisMaybe(a.occurredAt || a.createdAt));
  return serialize({
    conversation: publicConversation(access.id, access.data, contact, access.wabaMap, canClaim(actor, access.data, access.actorPhoneIds)),
    messages,
    notes,
    events,
  });
}

function newAuditRef() {
  return db.collection("gestionEventos").doc();
}

function auditPayload(actor, data, conversationId, type, metadata = {}) {
  return {
    conversationId,
    contactId: conversationPhone(data) || null,
    type,
    occurredAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    actorUid: actor.uid,
    actorEmail: actor.email,
    sellerUid: data.assignedToUid || actor.uid || null,
    sellerEmail: normalizeEmail(data.assignedToEmail || actor.email) || null,
    wabaPhoneId: getConversationPhoneId(data) || null,
    metadata,
  };
}

export async function updateCrmStatus(actor, payload) {
  const nextStatus = cleanString(payload.status, 80);
  if (!CRM_STATUS_SET.has(nextStatus)) {
    const error = new Error("Estado comercial inválido");
    error.statusCode = 400;
    throw error;
  }
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) {
      const error = new Error("No tenés permiso para cambiar este contacto");
      error.statusCode = 403;
      throw error;
    }
    const previousStatus = normalizedStatus(data);
    const manualAttention = nextStatus === "atendido" && !responseIsConfirmed(data);
    const patch = {
      gestionStatus: nextStatus,
      gestionStatusUpdatedAt: FieldValue.serverTimestamp(),
      gestionStatusUpdatedBy: actor.email,
      crmUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (manualAttention) {
      patch.manualAttentionAt = FieldValue.serverTimestamp();
      patch.manualAttentionBy = actor.email;
      patch.currentCycleManualAt = FieldValue.serverTimestamp();
      patch.responseConfirmation = "manual";
      patch.responseSource = "manual";
    }
    if (["nuevo", "pendiente"].includes(nextStatus)) {
      patch.currentCycleResponseAt = null;
      patch.currentCycleManualAt = null;
      patch.manualAttentionAt = null;
      patch.manualAttentionBy = null;
      patch.responseConfirmation = null;
      patch.responseSource = null;
    }
    if (nextStatus === "vendido") {
      patch.sold = true;
      patch.soldAt = data.soldAt || FieldValue.serverTimestamp();
      patch.soldByUid = actor.uid;
      patch.soldByEmail = actor.email;
    }
    if (previousStatus === "vendido" && nextStatus !== "vendido") {
      patch.sold = false;
      patch.soldRevertedAt = FieldValue.serverTimestamp();
      patch.soldRevertedByUid = actor.uid;
      patch.soldRevertedByEmail = actor.email;
    }
    if (nextStatus === "no_interesa" && payload.reason) {
      patch.noInterestReason = cleanString(payload.reason, 1000);
    }
    tx.set(access.ref, patch, { merge: true });
    const eventRef = newAuditRef();
    tx.create(
      eventRef,
      auditPayload(actor, data, access.id, nextStatus === "vendido" ? "marked_sold" : manualAttention ? "manual_attention" : "status_changed", {
        previousStatus,
        nextStatus,
        manualAttention,
      })
    );
    return serialize({ ok: true, status: nextStatus });
  });
}

export async function updateCrmClassification(actor, payload) {
  const keys = ["crmCustomerZone", "crmQualification", "crmUnqualifiedReason", "crmStage", "crmOutcome", "crmOutcomeReason"];
  const values = Object.fromEntries(keys.map((key) => [key, cleanString(payload[key], key === "crmCustomerZone" ? 160 : 120)]));
  const isAllowed = (key, allowed) => !values[key] || allowed.includes(values[key]);
  if (!isAllowed("crmQualification", CRM_QUALIFICATIONS) ||
      !isAllowed("crmUnqualifiedReason", CRM_UNQUALIFIED_REASONS) ||
      !isAllowed("crmStage", CRM_STAGES) ||
      !isAllowed("crmOutcome", CRM_OUTCOMES) ||
      !isAllowed("crmOutcomeReason", CRM_LOSS_REASONS)) {
    throw Object.assign(new Error("Clasificación comercial inválida"), { statusCode: 400 });
  }
  if (values.crmUnqualifiedReason && values.crmQualification !== "No calificado") {
    throw Object.assign(new Error("El motivo no calificado requiere esa calificación"), { statusCode: 400 });
  }
  if (values.crmOutcomeReason && !["Perdido", "Congelado"].includes(values.crmOutcome)) {
    throw Object.assign(new Error("El motivo de cierre corresponde a Perdido o Congelado"), { statusCode: 400 });
  }
  // No modificamos gestionStatus, sold ni datos del webhook.
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    if (!snap.exists) throw Object.assign(new Error("Conversación inexistente"), { statusCode: 404 });
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) {
      throw Object.assign(new Error("No tenés permiso para clasificar este contacto"), { statusCode: 403 });
    }
    const previous = Object.fromEntries(keys.map((key) => [key, cleanString(data[key], key === "crmCustomerZone" ? 160 : 120)]));
    const changed = keys.filter((key) => previous[key] !== values[key]);
    if (!changed.length) return { ok: true, unchanged: true };
    tx.set(access.ref, {
      ...values,
      crmClassificationUpdatedAt: FieldValue.serverTimestamp(),
      crmClassificationUpdatedBy: actor.email,
      crmUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, "classification_changed", {
      changes: Object.fromEntries(changed.map((key) => [key, { from: previous[key] || null, to: values[key] || null }])),
    }));
    return { ok: true, changed };
  });
}

function parseEconomicAmount(value, fieldLabel) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999999.99) {
    throw Object.assign(new Error(`${fieldLabel} inválido`), { statusCode: 400 });
  }
  return Math.round(amount * 100) / 100;
}

function parseEconomicDate(value, fieldLabel) {
  if (!value) return null;
  const date = toDate(value);
  if (!date || date.getFullYear() < 2000 || date.getTime() > Date.now() + 86400000) {
    throw Object.assign(new Error(`${fieldLabel} inválida`), { statusCode: 400 });
  }
  return date;
}

export async function updateCrmEconomics(actor, payload) {
  const kind = cleanString(payload.kind, 40);
  if (!['quote', 'confirmed_revenue'].includes(kind)) {
    throw Object.assign(new Error("Tipo de importe inválido"), { statusCode: 400 });
  }
  if (kind === "confirmed_revenue" && !actor.isAdmin) {
    throw Object.assign(new Error("Solo un administrador puede confirmar facturación"), { statusCode: 403 });
  }
  const amount = parseEconomicAmount(payload.amount, kind === "quote" ? "Importe presupuestado" : "Facturación confirmada");
  const currency = cleanString(payload.currency || "ARS", 12).toUpperCase();
  if (currency !== "ARS") {
    throw Object.assign(new Error("Los importes comerciales de esta ficha deben registrarse en ARS"), { statusCode: 400 });
  }
  const occurredAt = amount === null ? null : parseEconomicDate(payload.occurredAt, "Fecha del importe") || new Date();
  const expectedVersion = Math.max(0, Math.floor(Number(payload.expectedVersion) || 0));
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    if (!snap.exists) throw Object.assign(new Error("Conversación inexistente"), { statusCode: 404 });
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) throw Object.assign(new Error("Sin permiso"), { statusCode: 403 });
    const currentVersion = Math.max(0, Math.floor(Number(data.crmEconomicVersion) || 0));
    if (currentVersion !== expectedVersion) {
      throw Object.assign(new Error("La ficha económica cambió en otra sesión. Recargala antes de guardar."), { statusCode: 409 });
    }

    const isQuote = kind === "quote";
    const amountField = isQuote ? "crmQuoteAmount" : "crmConfirmedRevenueAmount";
    const currencyField = isQuote ? "crmQuoteCurrency" : "crmConfirmedRevenueCurrency";
    const dateField = isQuote ? "crmQuoteAt" : "crmConfirmedRevenueAt";
    const previous = optionalNumber(data[amountField]);
    const patch = {
      crmEconomicVersion: currentVersion + 1,
      crmEconomicUpdatedAt: FieldValue.serverTimestamp(),
      crmEconomicUpdatedByUid: actor.uid,
      crmEconomicUpdatedByEmail: actor.email,
      crmUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (amount === null) {
      patch[amountField] = FieldValue.delete();
      patch[currencyField] = FieldValue.delete();
      patch[dateField] = FieldValue.delete();
      if (isQuote) {
        patch.crmQuoteSellerUid = FieldValue.delete();
        patch.crmQuoteSellerEmail = FieldValue.delete();
        patch.crmQuoteSellerName = FieldValue.delete();
      } else {
        patch.crmConfirmedRevenueByUid = FieldValue.delete();
        patch.crmConfirmedRevenueByEmail = FieldValue.delete();
      }
    } else {
      patch[amountField] = amount;
      patch[currencyField] = currency;
      patch[dateField] = timestamp(occurredAt);
      if (isQuote) {
        patch.crmQuoteSellerUid = data.assignedToUid || actor.uid;
        patch.crmQuoteSellerEmail = normalizeEmail(data.assignedToEmail || actor.email);
        patch.crmQuoteSellerName = cleanString(data.assignedToName || actor.name, 200);
      } else {
        patch.crmConfirmedRevenueByUid = actor.uid;
        patch.crmConfirmedRevenueByEmail = actor.email;
      }
    }
    tx.set(access.ref, patch, { merge: true });
    tx.create(newAuditRef(), auditPayload(actor, data, access.id,
      isQuote ? (amount === null ? "quote_cleared" : "quote_updated") : (amount === null ? "confirmed_revenue_cleared" : "confirmed_revenue_updated"),
      { from: previous, to: amount, currency: amount === null ? null : currency, occurredAt: occurredAt?.toISOString() || null, version: currentVersion + 1 }
    ));
    return { ok: true, crmEconomicVersion: currentVersion + 1 };
  });
}

function marketingRange(filters = {}) {
  const parsed = parseRange(filters);
  const endExclusive = parsed.end || new Date();
  const start = parsed.start || new Date(endExclusive.getTime() - 29 * 86400000);
  if (endExclusive <= start) throw Object.assign(new Error("Rango de fechas inválido"), { statusCode: 400 });
  if (endExclusive.getTime() - start.getTime() > 367 * 86400000) {
    throw Object.assign(new Error("El rango publicitario no puede superar 367 días"), { statusCode: 400 });
  }
  const dayKey = (value) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
  return { start, endExclusive, since: dayKey(start), until: dayKey(new Date(endExclusive.getTime() - 1)) };
}

function marketingEntityFilter(value, label) {
  const normalized = cleanString(value, 80) || "all";
  if (normalized !== "all" && !/^\d{5,40}$/.test(normalized)) {
    throw Object.assign(new Error(`${label} inválido`), { statusCode: 400 });
  }
  return normalized;
}

export async function getMarketingDashboard(actor, filters = {}) {
  if (!actor.isAdmin) throw Object.assign(new Error("Acceso administrativo requerido"), { statusCode: 403 });
  const range = marketingRange(filters);
  const marketingFilters = {
    ...filters,
    adAccountId: marketingEntityFilter(filters.adAccountId, "ID de cuenta publicitaria"),
    campaignId: marketingEntityFilter(filters.campaignId, "ID de campaña"),
    adId: marketingEntityFilter(filters.adId, "ID de anuncio"),
  };
  const wabaRows = await loadWabaRows();
  const { rows, scannedCount, truncated } = await loadAccessibleRows(actor, wabaRows);
  const { campaign: _legacyCampaign, source: _legacySource, ...crmFilters } = filters;
  const contacts = rows.filter((row) => matchesFilter(row, crmFilters, { start: range.start, end: range.endExclusive }));
  const meta = await getMetaMarketingSnapshot({
    since: range.since,
    until: range.until,
    accountId: marketingFilters.adAccountId,
    force: filters.forceRefresh === true,
  });
  const performance = buildMarketingPerformance({
    contacts,
    campaigns: meta.campaigns,
    adsets: meta.adsets,
    ads: meta.ads,
    insights: meta.insights,
    dailyInsights: meta.dailyInsights,
    filters: marketingFilters,
  });
  return serialize({
    generatedAt: new Date(),
    range: { contactStart: range.start, contactEndExclusive: range.endExclusive, metaSince: range.since, metaUntilInclusive: range.until },
    meta: {
      configured: meta.configured,
      missingEnvironment: meta.missingEnvironment,
      apiVersion: meta.apiVersion || null,
      fetchedAt: meta.fetchedAt,
      cacheHit: meta.cacheHit,
      cacheTtlSeconds: meta.cacheTtlSeconds || null,
    },
    ...performance,
    options: {
      accounts: meta.accounts.map((row) => ({ id: String(row.account_id || row.id).replace(/^act_/, ""), name: row.name || row.account_id || row.id, currency: row.currency || null, status: row.account_status ?? null, timezone: row.timezone_name || null })),
      campaigns: meta.campaigns.map((row) => ({ id: String(row.id), name: row.name || row.id, accountId: row.accountId, status: row.status || null, effectiveStatus: row.effective_status || null })),
      adsets: meta.adsets.map((row) => ({ id: String(row.id), name: row.name || row.id, campaignId: String(row.campaign_id || ""), accountId: row.accountId, status: row.status || null, effectiveStatus: row.effective_status || null })),
      ads: meta.ads.map((row) => ({ id: row.id, name: row.name || row.id, campaignId: row.campaignId, accountId: row.accountId, status: row.status, effectiveStatus: row.effectiveStatus })),
    },
    coverage: { scannedConversations: scannedCount, conversationsTruncated: truncated },
  });
}

export async function getCrmZoneContacts(actor, payload = {}) {
  if (!actor.isAdmin) throw Object.assign(new Error("Acceso administrativo requerido"), { statusCode: 403 });
  const zone = cleanString(payload.customerZone, 160);
  if (!zone) throw Object.assign(new Error("Falta zona del cliente"), { statusCode: 400 });
  const wabaRows = await loadWabaRows();
  const { rows, truncated } = await loadAccessibleRows(actor, wabaRows);
  const filters = payload.filters || {};
  // El filtro geográfico se aplica DESPUÉS de desduplicar para detectar conflictos.
  const { customerZone: _ignoredCustomerZone, ...otherFilters } = filters;
  const filtered = rows.filter((row) => matchesFilter(row, otherFilters, parseRange(filters)));
  const grouped = groupUniqueZonePhones(filtered);
  const items = grouped.byZone.get(zone) || [];
  const page = Math.max(1, Math.min(100000, Math.floor(Number(payload.page) || 1)));
  const pageSize = 30;
  return serialize({ zone, total: items.length, page, pageSize, truncated,
    contacts: items.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
      id: row.id, name: row.name, phone: row.phone,
      assignedToName: row.assignedToName, assignedToEmail: row.assignedToEmail,
      crmCustomerZone: row.crmCustomerZone, crmQualification: row.crmQualification,
      crmStage: row.crmStage, crmOutcome: row.crmOutcome,
    })) });
}

export async function addCrmNote(actor, payload) {
  const note = cleanString(payload.note, 4000);
  if (!note) {
    const error = new Error("La nota está vacía");
    error.statusCode = 400;
    throw error;
  }
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  const noteRef = access.ref.collection("notes").doc();
  const eventRef = newAuditRef();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) throw Object.assign(new Error("Sin permiso"), { statusCode: 403 });
    tx.create(noteRef, {
      text: note,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: actor.uid,
      createdByEmail: actor.email,
      createdByName: actor.name,
    });
    tx.set(
      access.ref,
      { lastInternalNote: note, internalNote: note, lastInternalNoteAt: FieldValue.serverTimestamp(), crmUpdatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    tx.create(eventRef, auditPayload(actor, data, access.id, "note_created", { noteId: noteRef.id }));
  });
  return { ok: true, noteId: noteRef.id };
}

export async function scheduleCrmFollowUp(actor, payload) {
  const followUpDate = toDate(payload.followUpAt);
  if (!followUpDate) throw Object.assign(new Error("Fecha de seguimiento inválida"), { statusCode: 400 });
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  const note = cleanString(payload.note, 2000);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    const previousFollowUp = getFollowUp(data);
    if (!canManageConversation(actor, data)) throw Object.assign(new Error("Sin permiso"), { statusCode: 403 });
    tx.set(
      access.ref,
      {
        gestionStatus: "en_seguimiento",
        gestionStatusUpdatedAt: FieldValue.serverTimestamp(),
        gestionStatusUpdatedBy: actor.email,
        followUpAt: timestamp(followUpDate),
        followUpNote: note,
        followUpCompleted: false,
        followUpUpdatedAt: FieldValue.serverTimestamp(),
        followUpUpdatedByUid: actor.uid,
        followUpUpdatedByEmail: actor.email,
        followUpCreatedAt: data.followUpCreatedAt || FieldValue.serverTimestamp(),
        followUpCreatedByUid: data.followUpCreatedByUid || actor.uid,
        followUpCreatedByEmail: data.followUpCreatedByEmail || actor.email,
        crmUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.create(
      newAuditRef(),
      auditPayload(
        actor,
        data,
        access.id,
        previousFollowUp.at ? "follow_up_modified" : "follow_up_scheduled",
        { followUpAt: followUpDate.toISOString(), note }
      )
    );
  });
  return { ok: true };
}

export async function completeCrmFollowUp(actor, payload) {
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) throw Object.assign(new Error("Sin permiso"), { statusCode: 403 });
    tx.set(
      access.ref,
      {
        followUpCompleted: true,
        followUpCompletedAt: FieldValue.serverTimestamp(),
        followUpCompletedByUid: actor.uid,
        followUpCompletedByEmail: actor.email,
        crmUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, "follow_up_completed"));
  });
  return { ok: true };
}

export async function registerWhatsappOpen(actor, payload) {
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  const phoneDigits = digits(conversationPhone(access.data));
  if (!phoneDigits) {
    throw Object.assign(new Error("El contacto no tiene un teléfono válido"), { statusCode: 400 });
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    if (!canManageConversation(actor, data)) throw Object.assign(new Error("Sin permiso"), { statusCode: 403 });
    tx.set(
      access.ref,
      {
        whatsappOpenedAt: FieldValue.serverTimestamp(),
        whatsappOpenedByUid: actor.uid,
        whatsappOpenedByEmail: actor.email,
        whatsappOpenCount: FieldValue.increment(1),
        crmUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, "whatsapp_opened"));
  });
  return { ok: true, whatsappUrl: `https://wa.me/${phoneDigits}` };
}

export async function claimConversation(actor, payload) {
  if (actor.isAdmin) throw Object.assign(new Error("La autoasignación es para vendedores"), { statusCode: 400 });
  const access = await getConversationAccess(actor, payload.conversationId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    if (!isUnassigned(data) && !isAssignedTo(actor, data)) {
      throw Object.assign(new Error("La conversación ya fue asignada"), { statusCode: 409 });
    }
    if (isUnassigned(data) && !canClaim(actor, data, access.actorPhoneIds)) {
      throw Object.assign(new Error("La conversación no pertenece a tu bandeja"), { statusCode: 403 });
    }
    if (isAssignedTo(actor, data)) return;
    tx.set(
      access.ref,
      {
        assignedToUid: actor.uid,
        assignedToEmail: actor.email,
        assignedToName: actor.name,
        assignedAt: FieldValue.serverTimestamp(),
        crmUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, "assigned", { assignedToUid: actor.uid, assignedToEmail: actor.email }));
  });
  return { ok: true };
}

export async function assignConversation(actor, payload) {
  if (!actor.isAdmin) throw Object.assign(new Error("Solo un administrador puede reasignar"), { statusCode: 403 });
  const access = await getConversationAccess(actor, payload.conversationId, { requireManage: true });
  const assignedToUid = cleanString(payload.assignedToUid, 200);
  const assignedToEmail = normalizeEmail(payload.assignedToEmail);
  if (!assignedToUid && !assignedToEmail) throw Object.assign(new Error("Falta el vendedor destino"), { statusCode: 400 });
  const vendor = sanitizeVendorRows(access.wabaRows).find(
    (row) =>
      (assignedToUid && row.uid === assignedToUid) ||
      (assignedToEmail && row.email === assignedToEmail)
  );
  if (!vendor) {
    throw Object.assign(new Error("El vendedor destino no existe o está inactivo"), { statusCode: 400 });
  }
  const targetUid = vendor.uid || assignedToUid || null;
  const targetEmail = vendor.email || assignedToEmail || null;
  const assignedToName = cleanString(vendor.name || payload.assignedToName || targetEmail, 200);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(access.ref);
    const data = snap.data() || {};
    tx.set(
      access.ref,
      {
        assignedToUid: targetUid,
        assignedToEmail: targetEmail,
        assignedToName: assignedToName || null,
        assignedAt: FieldValue.serverTimestamp(),
        crmUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, isUnassigned(data) ? "assigned" : "reassigned", {
      previousUid: data.assignedToUid || null,
      previousEmail: data.assignedToEmail || null,
      assignedToUid: targetUid,
      assignedToEmail: targetEmail,
    }));
  });
  return { ok: true };
}

export async function takeChatbotConversation(actor, payload) {
  const access = await getConversationAccess(actor, payload.conversationId);
  const sessionRef = db.collection("chatbotSessions").doc(access.id);
  await db.runTransaction(async (tx) => {
    const [conversationSnapshot, sessionSnapshot] = await Promise.all([tx.get(access.ref), tx.get(sessionRef)]);
    const data = conversationSnapshot.data() || {};
    if (!actor.isAdmin) {
      if (!isUnassigned(data) && !isAssignedTo(actor, data)) {
        throw Object.assign(new Error("La conversación está asignada a otro vendedor"), { statusCode: 409 });
      }
      if (isUnassigned(data) && !canClaim(actor, data, access.actorPhoneIds)) {
        throw Object.assign(new Error("La conversación no pertenece a tu bandeja"), { statusCode: 403 });
      }
    }
    if (!sessionSnapshot.exists) throw Object.assign(new Error("La conversación no tiene una sesión de chatbot"), { statusCode: 409 });
    const session = sessionSnapshot.data() || {};
    const pendingRefs = (session.pendingOutboxIds || []).filter(Boolean).map((id) => db.collection("chatbotOutbox").doc(id));
    const pendingSnapshots = await Promise.all(pendingRefs.map((ref) => tx.get(ref)));
    const revision = Math.max(0, Number(session.revision) || 0);
    pendingSnapshots.forEach((snapshot, index) => {
      if (snapshot.exists && ["pending", "retry", "sending"].includes(snapshot.get("status"))) {
        tx.set(pendingRefs[index], {
          status: "cancelled",
          cancelReason: "HUMAN_TAKEOVER",
          cancelledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
    tx.set(sessionRef, {
      status: "HUMAN_ACTIVE",
      botSuspended: true,
      transferReason: session.transferReason || "HUMAN_TAKEOVER",
      pendingOutboxIds: [],
      revision: revision + 1,
      takenByUid: actor.uid,
      takenByEmail: actor.email,
      takenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(access.ref, {
      chatbotStatus: "HUMAN_ACTIVE",
      chatbotTransferStatus: "human_active",
      chatbotTransferReason: data.chatbotTransferReason || "HUMAN_TAKEOVER",
      chatbotTransferredAt: data.chatbotTransferredAt || FieldValue.serverTimestamp(),
      chatbotHumanActiveAt: FieldValue.serverTimestamp(),
      chatbotTakenAt: FieldValue.serverTimestamp(),
      chatbotTakenByUid: actor.uid,
      chatbotTakenByEmail: actor.email,
      chatbotLastSessionRevision: revision + 1,
      ...(!actor.isAdmin && isUnassigned(data) ? {
        assignedToUid: actor.uid,
        assignedToEmail: actor.email,
        assignedToName: actor.name,
        assignedAt: FieldValue.serverTimestamp(),
      } : {}),
      crmUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.create(newAuditRef(), auditPayload(actor, data, access.id, "chatbot_human_takeover", {
      previousStatus: session.status || null,
      previousRevision: revision,
      revision: revision + 1,
    }));
  });
  return { ok: true };
}

export function validateChatbotFlow(actor, payload) {
  if (!actor.isAdmin) {
    throw Object.assign(new Error("Acceso administrativo requerido"), { statusCode: 403 });
  }
  return { chatbot: validateFlowDefinition(payload.flow) };
}

export function simulateChatbotFlow(actor, payload) {
  if (!actor.isAdmin) {
    throw Object.assign(new Error("Acceso administrativo requerido"), { statusCode: 403 });
  }
  return { chatbot: simulateFlow(payload.flow, payload.responses || []) };
}

export async function handleCrmAction(req) {
  const actor = await authenticateCrmRequest(req);
  const body = parseBody(req);
  const action = cleanString(body.action, 80);
  if (action === "coexistence_config") return getCoexistenceConfig();
  if (action === "coexistence_complete") return completeCoexistence(actor, body);
  if (action === "dashboard") return getCrmDashboard(actor, body.filters || {});
  if (action === "detail") return getCrmContactDetail(actor, body.conversationId);
  if (action === "status") return updateCrmStatus(actor, body);
  if (action === "classification") return updateCrmClassification(actor, body);
  if (action === "economics") return updateCrmEconomics(actor, body);
  if (action === "marketing_dashboard") return getMarketingDashboard(actor, body.filters || {});
  if (action === "zone_contacts") return getCrmZoneContacts(actor, body);
  if (action === "note") return addCrmNote(actor, body);
  if (action === "follow_up") return scheduleCrmFollowUp(actor, body);
  if (action === "complete_follow_up") return completeCrmFollowUp(actor, body);
  if (action === "open_whatsapp") return registerWhatsappOpen(actor, body);
  if (action === "claim") return claimConversation(actor, body);
  if (action === "assign") return assignConversation(actor, body);
  if (action === "chatbot_takeover") return takeChatbotConversation(actor, body);
  if (action === "chatbot_validate") return validateChatbotFlow(actor, body);
  if (action === "chatbot_simulate") return simulateChatbotFlow(actor, body);
  if (isChatbotManagementAction(action)) return chatbotManagement.handleAction(actor, action, body);
  if (isChatbotOperationAction(action)) return chatbotOperations.handleAction(actor, action, body);
  throw Object.assign(new Error("Acción CRM inválida"), { statusCode: 400 });
}

export const crmInternals = {
  normalizedStatus,
  groupUniqueZonePhones,
  buildExcelAnalytics,
  buildMarketingPerformance,
  marketingRange,
  marketingEntityFilter,
  parseEconomicAmount,
  parseEconomicDate,
  responseIsConfirmed,
  buildSellerResponseMutation,
  parseSmbMessageEcho,
  percentileMedian,
  buildMetrics,
  matchesFilter,
  sanitizeEventId,
  serialize,
  publicChatbotAnswers,
  canClaim,
  canReadConversation,
  canManageConversation,
};
