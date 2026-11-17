import { db, FieldValue } from "./firebaseAdmin.js";
import { createFirestoreChatbotRuntimeStore } from "./chatbotRuntimeStore.js";

const CONFIG_COLLECTION = "chatbotRuntimeConfigs";
const CONFIG_AUDIT_COLLECTION = "chatbotRuntimeConfigEvents";

export const CHATBOT_OPERATION_ACTIONS = Object.freeze([
  "chatbot_runtime_configs_list",
  "chatbot_runtime_config_update",
  "chatbot_runtime_reactivate",
]);

const ACTIONS = new Set(CHATBOT_OPERATION_ACTIONS);

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeEmail(value) {
  return clean(value, 320).toLowerCase();
}

function fail(message, statusCode = 400, details = null) {
  const error = Object.assign(new Error(message), { statusCode });
  if (details) error.details = details;
  throw error;
}

function requireAdmin(actor) {
  if (!actor?.isAdmin || !actor?.uid || !actor?.email) fail("Acceso administrativo requerido", 403);
}

function phoneId(value) {
  const id = clean(value, 25);
  if (!/^\d{8,25}$/.test(id)) fail("Phone Number ID inválido");
  return id;
}

function positiveInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`El límite debe estar entre ${min} y ${max}`);
  return parsed;
}

function expectedRevision(value, exists) {
  const parsed = Number(value);
  const minimum = exists ? 1 : 0;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail("Revisión de configuración inválida");
  return parsed;
}

function tokenConfigured(env, id) {
  try {
    return Boolean(clean(JSON.parse(env.CHATBOT_META_TOKENS_JSON || "{}")?.[id], 4096));
  } catch {
    return false;
  }
}

function allowedPhoneIds(env) {
  return new Set(clean(env.CHATBOT_ALLOWED_PHONE_IDS, 4000).split(",").map((item) => item.trim()).filter(Boolean));
}

function localReadiness({ env, id, hasWaba, hasFlow, connectionVerified }) {
  const checks = {
    runtimeFlag: env.CHATBOT_RUNTIME_ENABLED === "true",
    sendFlag: env.CHATBOT_SEND_ENABLED === "true",
    allowlisted: allowedPhoneIds(env).has(id),
    tokenConfigured: tokenConfigured(env, id),
    graphVersionConfigured: /^v\d+\.\d+$/.test(clean(env.META_GRAPH_API_VERSION, 20)),
    appSecretConfigured: Boolean(clean(env.META_APP_SECRET, 4096)),
    webhookVerifyTokenConfigured: Boolean(clean(env.META_WA_VERIFY_TOKEN, 4096)),
    wabaConfigured: hasWaba,
    publishedFlowConfigured: hasFlow,
    metaConnectionVerified: connectionVerified === true,
  };
  return { checks, ready: Object.values(checks).every(Boolean) };
}

function wabaPhoneId(row = {}) {
  return clean(row.waPhoneId || row.phoneId || row.phoneNumberId || row.businessPhoneId || row.id, 25);
}

function sanitizeVendors(rows = []) {
  const result = new Map();
  for (const row of rows) {
    if (row.active === false) continue;
    const uid = clean(row.ownerUid || row.userUid, 200);
    const email = normalizeEmail(row.owner || row.ownerEmail || row.email);
    const key = uid || email;
    if (!key) continue;
    const current = result.get(key) || { uid: uid || null, email: email || null, phoneIds: [] };
    const id = wabaPhoneId(row);
    if (id && !current.phoneIds.includes(id)) current.phoneIds.push(id);
    current.name = clean(row.alias || row.name || current.name || email || uid, 200);
    current.zone = clean(row.zone || current.zone, 160) || "Sin zona";
    result.set(key, current);
  }
  return [...result.values()];
}

function publicConfig(id, data, readiness) {
  return {
    phoneId: id,
    revision: Math.max(0, Number(data?.revision) || 0),
    flowId: clean(data?.flowId, 160) || null,
    catalogId: clean(data?.catalogId, 160) || null,
    version: Number(data?.version) || null,
    defaultSellerUid: clean(data?.defaultSellerUid, 200) || null,
    defaultSellerEmail: normalizeEmail(data?.defaultSellerEmail) || null,
    defaultSellerName: clean(data?.defaultSellerName, 200) || null,
    maxMessagesPerSession: Math.max(1, Number(data?.maxMessagesPerSession) || 20),
    maxMessagesPerMinute: Math.max(1, Number(data?.maxMessagesPerMinute) || 10),
    maxSendAttempts: Math.max(1, Number(data?.maxSendAttempts) || 3),
    requestedEnabled: data?.requestedEnabled === true,
    enabled: data?.enabled === true && readiness.ready,
    connectionVerifiedAt: data?.connectionVerifiedAt || null,
    connectionStatus: readiness,
    updatedAt: data?.updatedAt || null,
    updatedByEmail: normalizeEmail(data?.updatedByEmail) || null,
  };
}

export function createChatbotOperationsService({
  database = db,
  fieldValue = FieldValue,
  env = process.env,
  runtimeStore = createFirestoreChatbotRuntimeStore({ database, fieldValue }),
} = {}) {
  const serverTimestamp = () => fieldValue.serverTimestamp();

  async function resources() {
    const [wabaSnapshot, flowSnapshot] = await Promise.all([
      database.collection("wabaNumbers").get(),
      database.collection("chatbotFlows").get(),
    ]);
    const wabaRows = wabaSnapshot.docs.map((document) => ({ id: document.id, ...(document.data() || {}) }));
    const numbers = wabaRows.map((row) => ({
      id: wabaPhoneId(row),
      display: clean(row.phone || row.displayPhoneNumber || row.alias || wabaPhoneId(row), 160),
      zone: clean(row.zone, 160) || "Sin zona",
      active: row.active !== false,
    })).filter((row) => /^\d{8,25}$/.test(row.id));
    const flows = flowSnapshot.docs.map((document) => {
      const data = document.data() || {};
      return {
        id: document.id,
        name: clean(data.name, 160),
        businessPhoneId: clean(data.businessPhoneId, 25) || null,
        status: data.status || "draft",
        publishedVersion: Number(data.publishedVersion) || null,
      };
    }).filter((flow) => flow.status === "published" && flow.publishedVersion);
    return { wabaRows, numbers, vendors: sanitizeVendors(wabaRows), flows };
  }

  async function listConfigs(actor) {
    requireAdmin(actor);
    const [configSnapshot, available] = await Promise.all([
      database.collection(CONFIG_COLLECTION).get(),
      resources(),
    ]);
    const byPhone = new Map(configSnapshot.docs.map((document) => [document.id, document.data() || {}]));
    const allPhoneIds = new Set([...available.numbers.map((item) => item.id), ...byPhone.keys()]);
    const configs = [...allPhoneIds].sort().map((id) => {
      const data = byPhone.get(id) || {};
      const hasWaba = available.numbers.some((item) => item.id === id && item.active);
      const hasFlow = available.flows.some((flow) => flow.id === data.flowId && flow.businessPhoneId === id && flow.publishedVersion >= Number(data.version));
      const readiness = localReadiness({ env, id, hasWaba, hasFlow, connectionVerified: Boolean(data.connectionVerifiedAt) });
      return publicConfig(id, data, readiness);
    });
    return { configs, numbers: available.numbers, vendors: available.vendors, flows: available.flows };
  }

  async function updateConfig(actor, payload = {}) {
    requireAdmin(actor);
    const id = phoneId(payload.phoneId);
    const flowId = clean(payload.flowId, 160);
    const version = positiveInteger(payload.version, null, 1, 1_000_000);
    if (!version) fail("Falta la versión publicada del flujo");
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(flowId)) fail("Flujo inválido");
    const available = await resources();
    const number = available.numbers.find((item) => item.id === id && item.active);
    if (!number) fail("El número empresarial no existe o está inactivo");
    const flow = available.flows.find((item) => item.id === flowId && item.businessPhoneId === id && item.publishedVersion >= version);
    if (!flow) fail("El flujo publicado no pertenece al número o la versión no existe");
    const sellerUid = clean(payload.defaultSellerUid, 200);
    const sellerEmail = normalizeEmail(payload.defaultSellerEmail);
    const seller = sellerUid || sellerEmail
      ? available.vendors.find((item) => (sellerUid && item.uid === sellerUid) || (sellerEmail && item.email === sellerEmail))
      : null;
    if ((sellerUid || sellerEmail) && !seller) fail("El vendedor responsable no existe o está inactivo");
    const maxMessagesPerSession = positiveInteger(payload.maxMessagesPerSession, 20, 1, 100);
    const maxMessagesPerMinute = positiveInteger(payload.maxMessagesPerMinute, 10, 1, 100);
    const maxSendAttempts = positiveInteger(payload.maxSendAttempts, 3, 1, 5);
    const requestedEnabled = payload.requestedEnabled === true;
    const ref = database.collection(CONFIG_COLLECTION).doc(id);
    const auditRef = database.collection(CONFIG_AUDIT_COLLECTION).doc();
    let result;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() || {} : {};
      const currentRevision = Math.max(0, Number(current.revision) || 0);
      const expected = expectedRevision(payload.expectedRevision, snapshot.exists);
      if (currentRevision !== expected) fail("La configuración cambió en otra sesión", 409, { currentRevision });
      const readiness = localReadiness({ env, id, hasWaba: true, hasFlow: true, connectionVerified: Boolean(current.connectionVerifiedAt) });
      const enabled = requestedEnabled && readiness.ready;
      const document = {
        schemaVersion: 1,
        phoneId: id,
        flowId,
        version,
        catalogId: clean(current.catalogId, 160) || null,
        defaultSellerUid: seller?.uid || null,
        defaultSellerEmail: seller?.email || null,
        defaultSellerName: seller?.name || null,
        maxMessagesPerSession,
        maxMessagesPerMinute,
        maxSendAttempts,
        requestedEnabled,
        enabled,
        connectionVerifiedAt: current.connectionVerifiedAt || null,
        revision: currentRevision + 1,
        createdAt: current.createdAt || serverTimestamp(),
        createdByUid: current.createdByUid || actor.uid,
        createdByEmail: current.createdByEmail || actor.email,
        updatedAt: serverTimestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      transaction.set(ref, document, { merge: false });
      transaction.create(auditRef, {
        phoneId: id,
        action: snapshot.exists ? "updated" : "created",
        actorUid: actor.uid,
        actorEmail: actor.email,
        previousRevision: currentRevision,
        revision: currentRevision + 1,
        requestedEnabled,
        effectiveEnabled: enabled,
        createdAt: serverTimestamp(),
      });
      result = publicConfig(id, document, readiness);
    });
    return { config: result };
  }

  async function reactivate(actor, payload = {}) {
    requireAdmin(actor);
    const conversationId = clean(payload.conversationId, 900);
    if (!conversationId) fail("Falta conversationId");
    const session = await runtimeStore.getSession(conversationId);
    if (!session) fail("Sesión inexistente", 404);
    const id = phoneId(session.phoneId);
    const configSnapshot = await database.collection(CONFIG_COLLECTION).doc(id).get();
    if (!configSnapshot.exists || configSnapshot.get("enabled") !== true || env.CHATBOT_RUNTIME_ENABLED !== "true") {
      fail("El runtime del número no está habilitado", 409);
    }
    const revision = positiveInteger(payload.expectedRevision, null, 1, 1_000_000_000);
    if (!revision) fail("Falta la revisión esperada de la sesión");
    return { session: await runtimeStore.reactivate({ conversationId, expectedRevision: revision, actor }) };
  }

  async function handleAction(actor, action, payload) {
    if (action === "chatbot_runtime_configs_list") return listConfigs(actor);
    if (action === "chatbot_runtime_config_update") return updateConfig(actor, payload);
    if (action === "chatbot_runtime_reactivate") return reactivate(actor, payload);
    fail("Acción operativa de chatbot inválida");
  }

  return Object.freeze({ listConfigs, updateConfig, reactivate, handleAction });
}

export function isChatbotOperationAction(action) {
  return ACTIONS.has(String(action || ""));
}

export const chatbotOperations = createChatbotOperationsService();
export const chatbotOperationsInternals = Object.freeze({
  localReadiness,
  publicConfig,
  sanitizeVendors,
  tokenConfigured,
  wabaPhoneId,
});
