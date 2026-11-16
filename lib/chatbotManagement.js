import { db, FieldValue } from "./firebaseAdmin.js";
import { validateFlowDefinition } from "./chatbotFlow.js";

const FLOW_COLLECTION = "chatbotFlows";
const AUDIT_COLLECTION = "chatbotFlowEvents";
const MAX_LIST_LIMIT = 100;
const MAX_VERSION_LIMIT = 100;

export const CHATBOT_MANAGEMENT_ACTIONS = Object.freeze([
  "chatbot_flows_list",
  "chatbot_flow_get",
  "chatbot_flow_create",
  "chatbot_flow_update",
  "chatbot_flow_delete",
  "chatbot_flow_duplicate",
  "chatbot_flow_publish",
  "chatbot_flow_versions",
  "chatbot_flow_restore",
]);

const ACTION_SET = new Set(CHATBOT_MANAGEMENT_ACTIONS);

function fail(message, statusCode = 400, details = null) {
  const error = Object.assign(new Error(message), { statusCode });
  if (details) error.details = details;
  throw error;
}

function cleanString(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function requireAdmin(actor) {
  if (!actor?.isAdmin || !actor?.uid || !actor?.email) {
    fail("Acceso administrativo requerido", 403);
  }
}

function requireFlowId(value) {
  const id = cleanString(value, 160);
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) fail("Identificador de flujo inválido");
  return id;
}

function requireExpectedRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("Falta una revisión válida para controlar cambios concurrentes");
  }
  return revision;
}

function requireVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) fail("Versión de flujo inválida");
  return version;
}

function versionDocumentId(version) {
  return `v${String(version).padStart(8, "0")}`;
}

function businessPhoneId(value) {
  const result = cleanString(value, 25);
  if (!result) return null;
  if (!/^\d{8,25}$/.test(result)) fail("El identificador del número empresarial es inválido");
  return result;
}

function validatedFlow(input, forcedId = null) {
  const validation = validateFlowDefinition(input);
  if (!validation.valid) {
    fail("El flujo contiene errores de validación", 422, {
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }
  return {
    validation,
    flow: { ...validation.flow, ...(forcedId ? { id: forcedId } : {}) },
  };
}

function revisionConflict(currentRevision) {
  fail("El flujo cambió en otra sesión. Recargalo antes de guardar.", 409, {
    currentRevision,
  });
}

function assertMutableDocument(snapshot, expectedRevision) {
  if (!snapshot.exists) fail("Flujo inexistente", 404);
  const data = snapshot.data() || {};
  if (data.status === "deleted" || data.deletedAt) fail("El flujo fue eliminado", 410);
  const currentRevision = Math.max(1, Number(data.revision) || 1);
  if (currentRevision !== expectedRevision) revisionConflict(currentRevision);
  return { data, currentRevision };
}

function toSerializable(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === "function") {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.map(toSerializable);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toSerializable(item)])
    );
  }
  return value;
}

function publicSummary(id, data = {}) {
  return toSerializable({
    id,
    name: cleanString(data.name, 160),
    description: cleanString(data.description, 1000),
    businessPhoneId: data.businessPhoneId || null,
    status: data.status || "draft",
    runtimeEnabled: false,
    revision: Math.max(1, Number(data.revision) || 1),
    versionCount: Math.max(0, Number(data.versionCount) || 0),
    publishedVersion: Number(data.publishedVersion) || null,
    hasUnpublishedChanges: data.hasUnpublishedChanges !== false,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    publishedAt: data.publishedAt || null,
    deletedAt: data.deletedAt || null,
    createdByEmail: data.createdByEmail || null,
    updatedByEmail: data.updatedByEmail || null,
  });
}

function publicFlow(id, data = {}) {
  return {
    ...publicSummary(id, data),
    draft: toSerializable(data.draft || null),
    validationWarnings: toSerializable(data.validationWarnings || []),
  };
}

function flowReferences(database, flowId = null) {
  const collection = database.collection(FLOW_COLLECTION);
  const flowRef = flowId ? collection.doc(flowId) : collection.doc();
  return {
    flowRef,
    auditRef: database.collection(AUDIT_COLLECTION).doc(),
  };
}

export function createChatbotManagementService({
  database = db,
  fieldValue = FieldValue,
} = {}) {
  const timestamp = () => fieldValue.serverTimestamp();

  async function listFlows(actor, payload = {}) {
    requireAdmin(actor);
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(Number(payload.limit) || 100)));
    const includeDeleted = payload.includeDeleted === true;
    const snapshot = await database
      .collection(FLOW_COLLECTION)
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    const flows = snapshot.docs
      .map((document) => publicSummary(document.id, document.data() || {}))
      .filter((flow) => includeDeleted || flow.status !== "deleted");
    return { flows };
  }

  async function getFlow(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const snapshot = await database.collection(FLOW_COLLECTION).doc(flowId).get();
    if (!snapshot.exists) fail("Flujo inexistente", 404);
    const data = snapshot.data() || {};
    if ((data.status === "deleted" || data.deletedAt) && payload.includeDeleted !== true) {
      fail("El flujo fue eliminado", 410);
    }
    return { flow: publicFlow(flowId, data) };
  }

  async function createFlow(actor, payload = {}) {
    requireAdmin(actor);
    const refs = flowReferences(database);
    const { validation, flow } = validatedFlow(payload.flow, refs.flowRef.id);
    const phoneId = businessPhoneId(payload.businessPhoneId);
    const now = timestamp();
    const document = {
      schemaVersion: 1,
      name: flow.name,
      description: flow.description,
      businessPhoneId: phoneId,
      status: "draft",
      runtimeEnabled: false,
      revision: 1,
      versionCount: 0,
      publishedVersion: null,
      hasUnpublishedChanges: true,
      draft: flow,
      validationWarnings: validation.warnings,
      createdAt: now,
      updatedAt: now,
      createdByUid: actor.uid,
      createdByEmail: actor.email,
      updatedByUid: actor.uid,
      updatedByEmail: actor.email,
    };
    await database.runTransaction(async (transaction) => {
      transaction.create(refs.flowRef, document);
      transaction.create(
        refs.auditRef,
        {
          flowId: refs.flowRef.id,
          action: "created",
          actorUid: actor.uid,
          actorEmail: actor.email,
          metadata: { revision: 1, businessPhoneId: phoneId },
          createdAt: timestamp(),
        }
      );
    });
    const createdSnapshot = await refs.flowRef.get();
    return { flow: publicFlow(refs.flowRef.id, createdSnapshot.data() || document) };
  }

  async function updateFlow(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const { validation, flow } = validatedFlow(payload.flow, flowId);
    const phoneId = businessPhoneId(payload.businessPhoneId);
    const { flowRef, auditRef } = flowReferences(database, flowId);
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(flowRef);
      const { data, currentRevision } = assertMutableDocument(snapshot, expectedRevision);
      const nextRevision = currentRevision + 1;
      const patch = {
        name: flow.name,
        description: flow.description,
        businessPhoneId: phoneId,
        runtimeEnabled: false,
        revision: nextRevision,
        hasUnpublishedChanges: true,
        draft: flow,
        validationWarnings: validation.warnings,
        updatedAt: timestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      transaction.update(flowRef, patch);
      transaction.create(auditRef, {
        flowId,
        action: "updated",
        actorUid: actor.uid,
        actorEmail: actor.email,
        metadata: { fromRevision: currentRevision, toRevision: nextRevision },
        createdAt: timestamp(),
      });
    });
    const updatedSnapshot = await flowRef.get();
    return { flow: publicFlow(flowId, updatedSnapshot.data() || {}) };
  }

  async function deleteFlow(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const { flowRef, auditRef } = flowReferences(database, flowId);
    let revision;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(flowRef);
      const { currentRevision } = assertMutableDocument(snapshot, expectedRevision);
      revision = currentRevision + 1;
      transaction.update(flowRef, {
        status: "deleted",
        runtimeEnabled: false,
        revision,
        deletedAt: timestamp(),
        deletedByUid: actor.uid,
        deletedByEmail: actor.email,
        updatedAt: timestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      });
      transaction.create(auditRef, {
        flowId,
        action: "deleted",
        actorUid: actor.uid,
        actorEmail: actor.email,
        metadata: { fromRevision: currentRevision, toRevision: revision },
        createdAt: timestamp(),
      });
    });
    return { deleted: true, flowId, revision };
  }

  async function duplicateFlow(actor, payload = {}) {
    requireAdmin(actor);
    const sourceFlowId = requireFlowId(payload.flowId);
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const sourceRef = database.collection(FLOW_COLLECTION).doc(sourceFlowId);
    const refs = flowReferences(database);
    await database.runTransaction(async (transaction) => {
      const sourceSnapshot = await transaction.get(sourceRef);
      const { data } = assertMutableDocument(sourceSnapshot, expectedRevision);
      const name = cleanString(payload.name, 160) || `${cleanString(data.name, 150)} (copia)`;
      const candidate = { ...(data.draft || {}), id: refs.flowRef.id, name };
      const { validation, flow } = validatedFlow(candidate, refs.flowRef.id);
      const phoneId = payload.businessPhoneId === undefined
        ? businessPhoneId(data.businessPhoneId)
        : businessPhoneId(payload.businessPhoneId);
      const now = timestamp();
      const document = {
        schemaVersion: 1,
        name: flow.name,
        description: flow.description,
        businessPhoneId: phoneId,
        status: "draft",
        runtimeEnabled: false,
        revision: 1,
        versionCount: 0,
        publishedVersion: null,
        hasUnpublishedChanges: true,
        draft: flow,
        validationWarnings: validation.warnings,
        duplicatedFromFlowId: sourceFlowId,
        createdAt: now,
        updatedAt: now,
        createdByUid: actor.uid,
        createdByEmail: actor.email,
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      transaction.create(refs.flowRef, document);
      transaction.create(refs.auditRef, {
        flowId: refs.flowRef.id,
        action: "duplicated",
        actorUid: actor.uid,
        actorEmail: actor.email,
        metadata: { sourceFlowId, sourceRevision: expectedRevision },
        createdAt: timestamp(),
      });
    });
    const duplicatedSnapshot = await refs.flowRef.get();
    return { flow: publicFlow(refs.flowRef.id, duplicatedSnapshot.data() || {}) };
  }

  async function publishFlow(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const { flowRef, auditRef } = flowReferences(database, flowId);
    let publishedVersion;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(flowRef);
      const { data, currentRevision } = assertMutableDocument(snapshot, expectedRevision);
      const { validation, flow } = validatedFlow(data.draft, flowId);
      const version = Math.max(0, Number(data.versionCount) || 0) + 1;
      publishedVersion = version;
      const nextRevision = currentRevision + 1;
      const versionRef = flowRef.collection("versions").doc(versionDocumentId(version));
      transaction.create(versionRef, {
        schemaVersion: 1,
        version,
        sourceRevision: currentRevision,
        flow,
        businessPhoneId: data.businessPhoneId || null,
        runtimeEnabled: false,
        validationWarnings: validation.warnings,
        publishedAt: timestamp(),
        publishedByUid: actor.uid,
        publishedByEmail: actor.email,
      });
      const patch = {
        status: "published",
        runtimeEnabled: false,
        revision: nextRevision,
        versionCount: version,
        publishedVersion: version,
        hasUnpublishedChanges: false,
        publishedAt: timestamp(),
        publishedByUid: actor.uid,
        publishedByEmail: actor.email,
        updatedAt: timestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      transaction.update(flowRef, patch);
      transaction.create(auditRef, {
        flowId,
        action: "published",
        actorUid: actor.uid,
        actorEmail: actor.email,
        metadata: { version, sourceRevision: currentRevision, toRevision: nextRevision },
        createdAt: timestamp(),
      });
    });
    const publishedSnapshot = await flowRef.get();
    return {
      flow: publicFlow(flowId, publishedSnapshot.data() || {}),
      version: publishedVersion,
    };
  }

  async function listVersions(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const limit = Math.max(1, Math.min(MAX_VERSION_LIMIT, Math.floor(Number(payload.limit) || 50)));
    const flowSnapshot = await database.collection(FLOW_COLLECTION).doc(flowId).get();
    if (!flowSnapshot.exists) fail("Flujo inexistente", 404);
    const snapshot = await database
      .collection(FLOW_COLLECTION)
      .doc(flowId)
      .collection("versions")
      .orderBy("version", "desc")
      .limit(limit)
      .get();
    return {
      versions: snapshot.docs.map((document) => toSerializable({
        id: document.id,
        ...(document.data() || {}),
        runtimeEnabled: false,
      })),
    };
  }

  async function restoreVersion(actor, payload = {}) {
    requireAdmin(actor);
    const flowId = requireFlowId(payload.flowId);
    const expectedRevision = requireExpectedRevision(payload.expectedRevision);
    const version = requireVersion(payload.version);
    const { flowRef, auditRef } = flowReferences(database, flowId);
    const versionRef = flowRef.collection("versions").doc(versionDocumentId(version));
    await database.runTransaction(async (transaction) => {
      const [flowSnapshot, versionSnapshot] = await Promise.all([
        transaction.get(flowRef),
        transaction.get(versionRef),
      ]);
      const { data, currentRevision } = assertMutableDocument(flowSnapshot, expectedRevision);
      if (!versionSnapshot.exists) fail("Versión inexistente", 404);
      const versionData = versionSnapshot.data() || {};
      const { validation, flow } = validatedFlow(versionData.flow, flowId);
      const nextRevision = currentRevision + 1;
      const patch = {
        name: flow.name,
        description: flow.description,
        businessPhoneId: businessPhoneId(versionData.businessPhoneId),
        runtimeEnabled: false,
        revision: nextRevision,
        hasUnpublishedChanges: true,
        draft: flow,
        validationWarnings: validation.warnings,
        restoredFromVersion: version,
        restoredAt: timestamp(),
        restoredByUid: actor.uid,
        restoredByEmail: actor.email,
        updatedAt: timestamp(),
        updatedByUid: actor.uid,
        updatedByEmail: actor.email,
      };
      transaction.update(flowRef, patch);
      transaction.create(auditRef, {
        flowId,
        action: "version_restored",
        actorUid: actor.uid,
        actorEmail: actor.email,
        metadata: { version, fromRevision: currentRevision, toRevision: nextRevision },
        createdAt: timestamp(),
      });
    });
    const restoredSnapshot = await flowRef.get();
    return {
      flow: publicFlow(flowId, restoredSnapshot.data() || {}),
      restoredFromVersion: version,
    };
  }

  async function handleAction(actor, action, payload = {}) {
    if (action === "chatbot_flows_list") return listFlows(actor, payload);
    if (action === "chatbot_flow_get") return getFlow(actor, payload);
    if (action === "chatbot_flow_create") return createFlow(actor, payload);
    if (action === "chatbot_flow_update") return updateFlow(actor, payload);
    if (action === "chatbot_flow_delete") return deleteFlow(actor, payload);
    if (action === "chatbot_flow_duplicate") return duplicateFlow(actor, payload);
    if (action === "chatbot_flow_publish") return publishFlow(actor, payload);
    if (action === "chatbot_flow_versions") return listVersions(actor, payload);
    if (action === "chatbot_flow_restore") return restoreVersion(actor, payload);
    fail("Acción de chatbot inválida");
  }

  return Object.freeze({
    listFlows,
    getFlow,
    createFlow,
    updateFlow,
    deleteFlow,
    duplicateFlow,
    publishFlow,
    listVersions,
    restoreVersion,
    handleAction,
  });
}

export function isChatbotManagementAction(action) {
  return ACTION_SET.has(action);
}

export const chatbotManagement = createChatbotManagementService();

export const chatbotManagementInternals = Object.freeze({
  businessPhoneId,
  publicFlow,
  publicSummary,
  requireExpectedRevision,
  requireFlowId,
  validatedFlow,
  versionDocumentId,
});
