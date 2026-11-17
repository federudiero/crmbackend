import { createHash } from "node:crypto";
import { db, FieldValue } from "./firebaseAdmin.js";

const SESSION_COLLECTION = "chatbotSessions";
const EVENT_COLLECTION = "chatbotRuntimeEvents";
const OUTBOX_COLLECTION = "chatbotOutbox";
const FLOW_COLLECTION = "chatbotFlows";

function eventDocumentId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function versionDocumentId(version) {
  return `v${String(version).padStart(8, "0")}`;
}

function eligibleConversation(data = {}) {
  return data.chatbotCommercialEligible === true && data.chatbotExcluded !== true && data.chatbotPersonal !== true;
}

function isAssigned(data = {}) {
  return Boolean(String(data.assignedToUid || "").trim() || String(data.assignedToEmail || "").trim());
}

async function configuredSeller(database, activation = {}) {
  const uid = String(activation.defaultSellerUid || "").trim();
  const email = String(activation.defaultSellerEmail || "").trim().toLowerCase();
  if (!uid && !email) return null;
  const snapshots = await Promise.all([
    uid ? database.collection("wabaNumbers").where("ownerUid", "==", uid).limit(10).get() : null,
    email ? database.collection("wabaNumbers").where("owner", "==", email).limit(10).get() : null,
  ]);
  const document = snapshots.flatMap((snapshot) => snapshot?.docs || []).find((item) => item.data()?.active !== false);
  if (!document) return null;
  const data = document.data() || {};
  return {
    uid: String(data.ownerUid || data.userUid || uid || "").trim() || null,
    email: String(data.owner || data.ownerEmail || data.email || email || "").trim().toLowerCase() || null,
    name: String(data.alias || data.name || activation.defaultSellerName || email || uid || "").trim() || null,
  };
}

export function createFirestoreChatbotRuntimeStore({ database = db, fieldValue = FieldValue } = {}) {
  const serverTimestamp = () => fieldValue.serverTimestamp();

  async function getConversation(conversationId) {
    const snapshot = await database.collection("conversations").doc(conversationId).get();
    return snapshot.exists ? { id: snapshot.id, ...(snapshot.data() || {}) } : null;
  }

  async function getPublishedFlow(phoneId) {
    // La activación operativa vive fuera del snapshot administrativo inmutable.
    // Etapa 2 no crea este documento, por lo que todos los flujos siguen inertes.
    const activationSnapshot = await database.collection("chatbotRuntimeConfigs").doc(phoneId).get();
    if (!activationSnapshot.exists || activationSnapshot.get("enabled") !== true) return null;
    const activation = activationSnapshot.data() || {};
    const flowId = String(activation.flowId || "").trim();
    const version = Number(activation.version);
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(flowId) || !Number.isSafeInteger(version) || version < 1) return null;
    const flowRef = database.collection(FLOW_COLLECTION).doc(flowId);
    const flowSnapshot = await flowRef.get();
    if (!flowSnapshot.exists) return null;
    const data = flowSnapshot.data() || {};
    if (data.status !== "published" || data.businessPhoneId !== phoneId || Number(data.publishedVersion) < version) return null;
    const versionSnapshot = await flowRef.collection("versions").doc(versionDocumentId(version)).get();
    if (!versionSnapshot.exists) return null;
    const versionData = versionSnapshot.data() || {};
    return {
      id: flowId,
      version,
      flow: versionData.flow || null,
      seller: await configuredSeller(database, activation),
      limits: {
        maxMessagesPerSession: Math.max(1, Number(activation.maxMessagesPerSession) || 20),
        maxMessagesPerMinute: Math.max(1, Number(activation.maxMessagesPerMinute) || 10),
        maxSendAttempts: Math.max(1, Number(activation.maxSendAttempts) || 3),
      },
    };
  }

  async function getAssignedCatalog(phoneId) {
    const configSnap = await database.collection("chatbotRuntimeConfigs").doc(phoneId).get();
    const catalogId = String(configSnap.exists ? configSnap.get("catalogId") || "" : "").trim();
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(catalogId)) return null;
    const catalogSnap = await database.collection("chatbotCatalogs").doc(catalogId).get();
    if (!catalogSnap.exists) return null;
    return { id: catalogSnap.id, ...(catalogSnap.data() || {}) };
  }

  async function getSession(conversationId) {
    const snapshot = await database.collection(SESSION_COLLECTION).doc(conversationId).get();
    return snapshot.exists ? { id: snapshot.id, ...(snapshot.data() || {}) } : null;
  }

  async function commitInbound({ conversationId, eventId, expectedRevision, session, outbox, cancelOutboxIds = [], transfer = null }) {
    const sessionRef = database.collection(SESSION_COLLECTION).doc(conversationId);
    const conversationRef = database.collection("conversations").doc(conversationId);
    const eventRef = database.collection(EVENT_COLLECTION).doc(eventId);
    const outboxRef = outbox ? database.collection(OUTBOX_COLLECTION).doc(outbox.id) : null;
    // El pedido es una solicitud comercial confirmada por el cliente, no una venta cobrada.
    // La clave deriva del webhook: un reintento del mismo evento no crea otro pedido.
    const orderRef = transfer?.orderConfirmed === true
      ? database.collection("chatbotPedidos").doc(`pedido_${eventId}`)
      : null;
    const cancelRefs = [...new Set(cancelOutboxIds)].filter(Boolean).map((id) => database.collection(OUTBOX_COLLECTION).doc(id));
    let outcome = { kind: "conflict" };
    await database.runTransaction(async (transaction) => {
      // Al confirmar, releer precio Y asignación dentro de la misma transacción.
      // Una edición simultánea del catálogo invalida la confirmación.
      const priceQuote = transfer?.orderConfirmed === true ? transfer.catalogEstimate : null;
      const quoteCatalogRef = priceQuote ? database.collection("chatbotCatalogs").doc(priceQuote.catalogId) : null;
      const quoteConfigRef = priceQuote ? database.collection("chatbotRuntimeConfigs").doc(session.phoneId) : null;
      const [eventSnapshot, sessionSnapshot, conversationSnapshot, quoteCatalogSnapshot, quoteConfigSnapshot, ...cancelSnapshots] = await Promise.all([
        transaction.get(eventRef),
        transaction.get(sessionRef),
        transaction.get(conversationRef),
        quoteCatalogRef ? transaction.get(quoteCatalogRef) : Promise.resolve(null),
        quoteConfigRef ? transaction.get(quoteConfigRef) : Promise.resolve(null),
        ...cancelRefs.map((ref) => transaction.get(ref)),
      ]);
      if (eventSnapshot.exists) {
        outcome = { kind: "duplicate", outboxId: eventSnapshot.get("outboxId") || null };
        return;
      }
      const conversation = conversationSnapshot.exists ? conversationSnapshot.data() || {} : {};
      if (!conversationSnapshot.exists || !eligibleConversation(conversation)) {
        transaction.create(eventRef, {
          kind: "inbound",
          conversationId,
          status: "ignored",
          reason: "CONTACT_NOT_ELIGIBLE",
          createdAt: serverTimestamp(),
        });
        outcome = { kind: "ignored", reason: "CONTACT_NOT_ELIGIBLE" };
        return;
      }
      const currentRevision = sessionSnapshot.exists ? Math.max(0, Number(sessionSnapshot.get("revision")) || 0) : 0;
      if (currentRevision !== expectedRevision) {
        outcome = { kind: "conflict", currentRevision };
        return;
      }
      if (priceQuote) {
        const data = quoteCatalogSnapshot?.exists ? quoteCatalogSnapshot.data() || {} : {};
        const items = Array.isArray(priceQuote.items) ? priceQuote.items : [{
          sku: priceQuote.sku, quantity: priceQuote.quantity,
          unitPrice: priceQuote.unitPrice, lineTotal: priceQuote.subtotal,
        }];
        let calculated = 0;
        const itemSkus = new Set();
        let validItems = items.length >= 1 && items.length <= 3;
        for (const item of items) {
          const product = (data.products || []).find((row) => row.sku === item.sku && row.active !== false);
          const total = Number(item.unitPrice) * Number(item.quantity);
          if (!product || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 ||
              !Number.isSafeInteger(item.unitPrice) || item.unitPrice <= 0 || product.price !== item.unitPrice ||
              !Number.isSafeInteger(total) || total !== item.lineTotal || itemSkus.has(item.sku)) {
            validItems = false;
            break;
          }
          itemSkus.add(item.sku);
          calculated += total;
          if (!Number.isSafeInteger(calculated)) { validItems = false; break; }
        }
        if (!quoteConfigSnapshot?.exists || quoteConfigSnapshot.get("catalogId") !== priceQuote.catalogId ||
            !quoteCatalogSnapshot?.exists || data.active !== true || Number(data.revision) !== priceQuote.catalogRevision ||
            data.currency !== "ARS" || priceQuote.currency !== "ARS" ||
            !validItems || calculated !== priceQuote.subtotal) {
          outcome = { kind: "conflict", reason: "CATALOG_CHANGED" };
          return;
        }
      }
      transaction.set(sessionRef, { ...session, revision: currentRevision + 1, updatedAt: serverTimestamp() }, { merge: false });
      cancelSnapshots.forEach((snapshot, index) => {
        if (!snapshot.exists || !["pending", "retry", "sending"].includes(snapshot.get("status"))) return;
        transaction.set(cancelRefs[index], {
          status: "cancelled",
          cancelReason: transfer?.reason || "SESSION_ADVANCED",
          cancelledAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
      });
      if (outboxRef) transaction.create(outboxRef, { ...outbox, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      if (transfer) {
        const seller = !isAssigned(conversation) ? transfer.seller : null;
        const currentStatus = String(conversation.gestionStatus || "").trim();
        const preserveStatus = ["atendido", "vendido", "no_interesa", "numero_incorrecto"].includes(currentStatus);
        const conversationPatch = {
          chatbotStatus: "READY_FOR_HUMAN",
          chatbotTransferStatus: seller ? "assigned" : isAssigned(conversation) ? "assigned" : "pending_assignment",
          chatbotTransferReason: transfer.reason,
          chatbotTransferredAt: serverTimestamp(),
          chatbotFlowId: transfer.flowId,
          chatbotFlowVersion: transfer.flowVersion,
          chatbotAnswers: transfer.answers || {},
          chatbotCurrentQuestionId: transfer.currentQuestionId || null,
          chatbotFormCompleted: ["FLOW_COMPLETED", "ORDER_CONFIRMED"].includes(transfer.reason),
          chatbotOrderConfirmed: transfer.orderConfirmed === true,
          ...(orderRef ? { chatbotOrderId: orderRef.id } : {}),
          ...(transfer.orderConfirmed === true ? { chatbotOrderConfirmedAt: serverTimestamp() } : {}),
          chatbotLastSessionRevision: currentRevision + 1,
          crmUpdatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          ...(preserveStatus ? {} : { gestionStatus: "pendiente" }),
          ...(seller ? {
            assignedToUid: seller.uid || null,
            assignedToEmail: seller.email || null,
            assignedToName: seller.name || null,
            assignedAt: serverTimestamp(),
          } : {}),
        };
        transaction.set(conversationRef, conversationPatch, { merge: true });
        if (orderRef) {
          transaction.create(orderRef, {
            schemaVersion: 1,
            kind: "chatbot_customer_confirmed_request",
            status: "pendiente_coordinacion",
            paymentStatus: "no_verificado",
            fulfillmentStatus: "no_coordinado",
            priceVerified: false,
            ...(transfer.catalogEstimate ? { catalogEstimate: transfer.catalogEstimate } : {}),
            conversationId,
            contactPhone: session.contactPhone || null,
            businessPhoneId: session.phoneId || null,
            flowId: transfer.flowId,
            flowVersion: transfer.flowVersion,
            answers: transfer.answers || {},
            sellerUid: seller?.uid || conversation.assignedToUid || null,
            sellerEmail: seller?.email || conversation.assignedToEmail || null,
            attributionSourceId: conversation.referralSourceId || null,
            confirmedBy: "customer",
            confirmedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          });
        }
        transaction.create(database.collection("gestionEventos").doc(`chatbot_transfer_${eventId}`), {
          conversationId,
          contactId: session.contactPhone || null,
          type: "chatbot_transfer",
          occurredAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          actorUid: null,
          actorEmail: null,
          sellerUid: seller?.uid || conversation.assignedToUid || null,
          sellerEmail: seller?.email || conversation.assignedToEmail || null,
          wabaPhoneId: session.phoneId || null,
          metadata: { reason: transfer.reason, flowId: transfer.flowId, flowVersion: transfer.flowVersion },
        });
      } else {
        transaction.set(conversationRef, {
          chatbotStatus: session.status,
          chatbotFlowId: session.flowId,
          chatbotFlowVersion: session.flowVersion,
          chatbotCurrentQuestionId: session.state?.currentQuestionId || null,
          chatbotLastInboundAtMs: session.lastInboundAtMs,
          chatbotLastSessionRevision: currentRevision + 1,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(eventRef, {
        kind: "inbound",
        conversationId,
        status: "processed",
        outboxId: outbox?.id || null,
        occurredAtMs: session.lastInboundAtMs,
        createdAt: serverTimestamp(),
      });
      outcome = { kind: "committed", revision: currentRevision + 1, outboxId: outbox?.id || null };
    });
    return outcome;
  }

  async function claimOutbox(outboxId, nowMs, maxAttempts, maxPerMinute) {
    const ref = database.collection(OUTBOX_COLLECTION).doc(outboxId);
    let claimed = null;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const data = snapshot.data() || {};
      const sessionRef = database.collection(SESSION_COLLECTION).doc(data.conversationId || "__missing__");
      const sessionSnapshot = await transaction.get(sessionRef);
      const attempts = Math.max(0, Number(data.attempts) || 0);
      const effectiveMaxAttempts = Math.min(maxAttempts, Math.max(1, Number(data.maxSendAttempts) || maxAttempts));
      const effectiveMaxPerMinute = Math.min(maxPerMinute, Math.max(1, Number(data.maxOutboundPerMinute) || maxPerMinute));
      const staleClaim = data.status === "sending" && nowMs - Number(data.claimedAtMs || 0) > 60_000;
      if (!["pending", "retry"].includes(data.status) && !staleClaim) return;
      if (attempts >= effectiveMaxAttempts) return;
      if (sessionSnapshot.exists && sessionSnapshot.get("botSuspended") === true && data.allowAfterTransfer !== true) {
        transaction.set(ref, { status: "cancelled", cancelReason: "HUMAN_TRANSFER", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
        return;
      }
      const remaining = Math.max(0, (data.intents || []).length - Math.max(0, Number(data.nextIntentIndex) || 0));
      const bucketId = `${String(data.phoneId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")}_${Math.floor(nowMs / 60_000)}`;
      const rateRef = database.collection("chatbotRateLimits").doc(bucketId);
      const rateSnapshot = await transaction.get(rateRef);
      const used = rateSnapshot.exists ? Math.max(0, Number(rateSnapshot.get("count")) || 0) : 0;
      if (used + remaining > effectiveMaxPerMinute) {
        transaction.set(ref, { status: "retry", lastError: { code: "RATE_LIMIT", message: "Límite de envío por minuto alcanzado" }, updatedAt: serverTimestamp() }, { merge: true });
        return;
      }
      claimed = { id: snapshot.id, ...data, attempts: attempts + 1 };
      transaction.set(rateRef, { phoneId: data.phoneId, minuteBucket: Math.floor(nowMs / 60_000), count: used + remaining, updatedAt: serverTimestamp() }, { merge: false });
      transaction.update(ref, {
        status: "sending",
        attempts: attempts + 1,
        claimedAtMs: nowMs,
        updatedAt: serverTimestamp(),
      });
    });
    return claimed;
  }

  async function markOutboxProgress(outboxId, nextIntentIndex, results) {
    const ref = database.collection(OUTBOX_COLLECTION).doc(outboxId);
    let advanced = false;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("status") !== "sending") return;
      transaction.set(ref, { nextIntentIndex, results, updatedAt: serverTimestamp() }, { merge: true });
      advanced = true;
    });
    return advanced;
  }

  async function markOutboxSent(outboxId, results) {
    const ref = database.collection(OUTBOX_COLLECTION).doc(outboxId);
    let sent = false;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("status") !== "sending") return;
      transaction.set(ref, { status: "sent", results, sentAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      sent = true;
    });
    return sent;
  }

  async function markOutboxFailed(outboxId, { retryable, code, message, final, conversationId }) {
    const outboxRef = database.collection(OUTBOX_COLLECTION).doc(outboxId);
    const sessionRef = database.collection(SESSION_COLLECTION).doc(conversationId);
    const conversationRef = database.collection("conversations").doc(conversationId);
    await database.runTransaction(async (transaction) => {
      const [outboxSnapshot, sessionSnapshot, conversationSnapshot] = await Promise.all([
        transaction.get(outboxRef), transaction.get(sessionRef), transaction.get(conversationRef),
      ]);
      if (!outboxSnapshot.exists || outboxSnapshot.get("status") === "cancelled") return;
      transaction.set(outboxRef, {
        status: final || !retryable ? "failed" : "retry",
        lastError: { code, message },
        updatedAt: serverTimestamp(),
      }, { merge: true });
      if (final || !retryable) {
        const session = sessionSnapshot.exists ? sessionSnapshot.data() || {} : {};
        const conversation = conversationSnapshot.exists ? conversationSnapshot.data() || {} : {};
        transaction.set(sessionRef, {
          status: "ERROR",
          botSuspended: true,
          transferReason: "SEND_ERROR",
          updatedAt: serverTimestamp(),
        }, { merge: true });
        for (const id of session.pendingOutboxIds || []) {
          if (id === outboxId) continue;
          transaction.set(database.collection(OUTBOX_COLLECTION).doc(id), { status: "cancelled", cancelReason: "SEND_ERROR", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
        }
        const seller = !isAssigned(conversation) ? session.defaultSeller || null : null;
        transaction.set(conversationRef, {
          chatbotStatus: "ERROR",
          chatbotTransferStatus: seller ? "assigned" : isAssigned(conversation) ? "assigned" : "pending_assignment",
          chatbotTransferReason: "SEND_ERROR",
          chatbotTransferredAt: serverTimestamp(),
          chatbotAnswers: session.state?.answers || {},
          chatbotCurrentQuestionId: session.state?.currentQuestionId || null,
          chatbotFormCompleted: false,
          ...(seller ? { assignedToUid: seller.uid || null, assignedToEmail: seller.email || null, assignedToName: seller.name || null, assignedAt: serverTimestamp() } : {}),
          crmUpdatedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
      }
    });
  }

  async function suspendForHuman({ conversationId, eventId, occurredAtMs }) {
    const sessionRef = database.collection(SESSION_COLLECTION).doc(conversationId);
    const eventRef = database.collection(EVENT_COLLECTION).doc(eventId);
    let outcome = { kind: "missing" };
    await database.runTransaction(async (transaction) => {
      const conversationRef = database.collection("conversations").doc(conversationId);
      const [eventSnapshot, sessionSnapshot, conversationSnapshot] = await Promise.all([transaction.get(eventRef), transaction.get(sessionRef), transaction.get(conversationRef)]);
      if (eventSnapshot.exists) {
        outcome = { kind: "duplicate" };
        return;
      }
      if (!sessionSnapshot.exists) {
        transaction.create(eventRef, { kind: "human_echo", conversationId, status: "ignored", createdAt: serverTimestamp() });
        return;
      }
      const revision = Math.max(0, Number(sessionSnapshot.get("revision")) || 0);
      const session = sessionSnapshot.data() || {};
      const conversation = conversationSnapshot.exists ? conversationSnapshot.data() || {} : {};
      const pendingRefs = (session.pendingOutboxIds || []).filter(Boolean).map((id) => database.collection(OUTBOX_COLLECTION).doc(id));
      const pendingSnapshots = await Promise.all(pendingRefs.map((ref) => transaction.get(ref)));
      pendingSnapshots.forEach((snapshot, index) => {
        if (snapshot.exists && ["pending", "retry", "sending"].includes(snapshot.get("status"))) {
          transaction.set(pendingRefs[index], { status: "cancelled", cancelReason: "HUMAN_INTERVENTION", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
        }
      });
      transaction.set(sessionRef, {
        status: "HUMAN_ACTIVE",
        botSuspended: true,
        transferReason: "HUMAN_INTERVENTION",
        lastHumanMessageAtMs: occurredAtMs,
        revision: revision + 1,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      const seller = !isAssigned(conversation) ? session.defaultSeller || null : null;
      transaction.set(conversationRef, {
        chatbotStatus: "HUMAN_ACTIVE",
        chatbotTransferStatus: seller ? "assigned" : isAssigned(conversation) ? "assigned" : "pending_assignment",
        chatbotTransferReason: "HUMAN_INTERVENTION",
        chatbotTransferredAt: conversation.chatbotTransferredAt || serverTimestamp(),
        chatbotHumanActiveAt: serverTimestamp(),
        chatbotAnswers: session.state?.answers || {},
        ...(seller ? { assignedToUid: seller.uid || null, assignedToEmail: seller.email || null, assignedToName: seller.name || null, assignedAt: serverTimestamp() } : {}),
        crmUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      transaction.create(eventRef, { kind: "human_echo", conversationId, status: "processed", occurredAtMs, createdAt: serverTimestamp() });
      outcome = { kind: "suspended" };
    });
    return outcome;
  }

  async function reactivate({ conversationId, expectedRevision, actor }) {
    const ref = database.collection(SESSION_COLLECTION).doc(conversationId);
    const conversationRef = database.collection("conversations").doc(conversationId);
    let result = null;
    await database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw Object.assign(new Error("Sesión inexistente"), { statusCode: 404 });
      const data = snapshot.data() || {};
      const revision = Math.max(0, Number(data.revision) || 0);
      if (revision !== expectedRevision) throw Object.assign(new Error("Conflicto de revisión"), { statusCode: 409, details: { currentRevision: revision } });
      const next = {
        ...data,
        state: null,
        status: "BOT_PENDING",
        botSuspended: false,
        transferReason: null,
        outboundCount: 0,
        revision: revision + 1,
        reactivatedByUid: actor.uid,
        reactivatedByEmail: actor.email,
        reactivatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      transaction.set(ref, next, { merge: false });
      transaction.set(conversationRef, {
        chatbotStatus: "BOT_PENDING",
        chatbotTransferStatus: "reactivated",
        chatbotReactivatedAt: serverTimestamp(),
        chatbotReactivatedByUid: actor.uid,
        chatbotReactivatedByEmail: actor.email,
        chatbotLastSessionRevision: revision + 1,
        crmUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      transaction.create(database.collection("gestionEventos").doc(), {
        conversationId,
        contactId: data.contactPhone || null,
        type: "chatbot_reactivated",
        occurredAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        actorUid: actor.uid,
        actorEmail: actor.email,
        sellerUid: null,
        sellerEmail: null,
        wabaPhoneId: data.phoneId || null,
        metadata: { previousStatus: data.status || null, previousRevision: revision, revision: revision + 1 },
      });
      result = { id: conversationId, ...next };
    });
    return result;
  }

  return Object.freeze({
    getConversation,
    getPublishedFlow,
    getAssignedCatalog,
    getSession,
    commitInbound,
    claimOutbox,
    markOutboxProgress,
    markOutboxSent,
    markOutboxFailed,
    suspendForHuman,
    reactivate,
  });
}

export const chatbotRuntimeStoreInternals = Object.freeze({
  configuredSeller,
  eligibleConversation,
  eventDocumentId,
  versionDocumentId,
});
