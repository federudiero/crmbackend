import test from "node:test";
import assert from "node:assert/strict";
import { createChatbotRuntime } from "../lib/chatbotRuntime.js";
import { buildChatbotGraphPayload, createChatbotSender } from "../lib/chatbotSender.js";

const clone = (value) => value == null ? value : structuredClone(value);

function baseFlow() {
  return {
    schemaVersion: 1,
    id: "commercial",
    name: "Comercial",
    welcomeMessage: "Hola",
    closingMessage: "Gracias",
    invalidMessage: "Respuesta inválida",
    maxAttempts: 2,
    startQuestionId: "need",
    transfer: { onComplete: true, humanKeywords: ["vendedor"], message: "Te derivamos" },
    questions: [
      { id: "need", key: "need", prompt: "¿Qué necesitás?", type: "text", required: true, validation: {}, options: [], branches: [], nextQuestionId: "city" },
      { id: "city", key: "city", prompt: "¿De qué ciudad sos?", type: "text", required: true, validation: {}, options: [], branches: [], nextQuestionId: null },
    ],
  };
}

class MemoryRepository {
  constructor() {
    this.conversations = new Map([["phone_1__5491111111111", { chatbotCommercialEligible: true }]]);
    this.published = { id: "flow_1", version: 1, flow: baseFlow(), seller: null, limits: { maxMessagesPerSession: 20, maxMessagesPerMinute: 10, maxSendAttempts: 3 } };
    this.sessions = new Map();
    this.events = new Map();
    this.outboxes = new Map();
  }

  async getConversation(id) { return clone(this.conversations.get(id) || null); }
  async getPublishedFlow() { return clone(this.published); }
  async getSession(id) { return clone(this.sessions.get(id) || null); }

  async commitInbound({ conversationId, eventId, expectedRevision, session, outbox, cancelOutboxIds = [], transfer = null }) {
    if (this.events.has(eventId)) return { kind: "duplicate", outboxId: this.events.get(eventId).outboxId || null };
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.chatbotCommercialEligible || conversation.chatbotExcluded || conversation.chatbotPersonal) return { kind: "ignored", reason: "CONTACT_NOT_ELIGIBLE" };
    const current = this.sessions.get(conversationId);
    const revision = Number(current?.revision || 0);
    if (revision !== expectedRevision) return { kind: "conflict", currentRevision: revision };
    this.sessions.set(conversationId, { ...clone(session), revision: revision + 1 });
    for (const id of cancelOutboxIds) {
      const previous = this.outboxes.get(id);
      if (previous && ["pending", "retry", "sending"].includes(previous.status)) Object.assign(previous, { status: "cancelled", cancelReason: transfer?.reason || "SESSION_ADVANCED" });
    }
    if (outbox) this.outboxes.set(outbox.id, clone(outbox));
    if (transfer) {
      Object.assign(conversation, {
        chatbotStatus: "READY_FOR_HUMAN",
        chatbotTransferReason: transfer.reason,
        chatbotAnswers: clone(transfer.answers),
        chatbotFormCompleted: transfer.reason === "FLOW_COMPLETED",
        ...(transfer.seller && !conversation.assignedToUid && !conversation.assignedToEmail ? { assignedToUid: transfer.seller.uid, assignedToEmail: transfer.seller.email } : {}),
      });
    } else conversation.chatbotStatus = session.status;
    this.events.set(eventId, { outboxId: outbox?.id || null });
    return { kind: "committed", revision: revision + 1, outboxId: outbox?.id || null };
  }

  async claimOutbox(id, nowMs, maxAttempts) {
    const item = this.outboxes.get(id);
    if (!item || !["pending", "retry"].includes(item.status) || item.attempts >= maxAttempts) return null;
    item.status = "sending";
    item.attempts += 1;
    item.claimedAtMs = nowMs;
    return clone(item);
  }

  async markOutboxSent(id, results) {
    const item = this.outboxes.get(id);
    if (!item || item.status !== "sending") return false;
    Object.assign(item, { status: "sent", results: clone(results) });
    return true;
  }

  async markOutboxProgress(id, nextIntentIndex, results) {
    const item = this.outboxes.get(id);
    if (!item || item.status !== "sending") return false;
    Object.assign(item, { nextIntentIndex, results: clone(results) });
    return true;
  }

  async markOutboxFailed(id, { retryable, code, message, final, conversationId }) {
    Object.assign(this.outboxes.get(id), { status: final || !retryable ? "failed" : "retry", lastError: { code, message } });
    if (final || !retryable) Object.assign(this.sessions.get(conversationId), { status: "ERROR", botSuspended: true, transferReason: "SEND_ERROR" });
  }

  async suspendForHuman({ conversationId, eventId, occurredAtMs }) {
    if (this.events.has(eventId)) return { kind: "duplicate" };
    this.events.set(eventId, {});
    const session = this.sessions.get(conversationId);
    if (!session) return { kind: "missing" };
    Object.assign(session, { status: "HUMAN_ACTIVE", botSuspended: true, transferReason: "HUMAN_INTERVENTION", lastHumanMessageAtMs: occurredAtMs, revision: session.revision + 1 });
    for (const id of session.pendingOutboxIds || []) {
      const outbox = this.outboxes.get(id);
      if (outbox && ["pending", "retry", "sending"].includes(outbox.status)) Object.assign(outbox, { status: "cancelled", cancelReason: "HUMAN_INTERVENTION" });
    }
    Object.assign(this.conversations.get(conversationId), { chatbotStatus: "HUMAN_ACTIVE", chatbotTransferReason: "HUMAN_INTERVENTION" });
    return { kind: "suspended" };
  }

  async reactivate({ conversationId, expectedRevision, actor }) {
    const session = this.sessions.get(conversationId);
    if (!session) throw Object.assign(new Error("Sesión inexistente"), { statusCode: 404 });
    if (session.revision !== expectedRevision) throw Object.assign(new Error("Conflicto"), { statusCode: 409 });
    Object.assign(session, { state: null, status: "BOT_PENDING", botSuspended: false, transferReason: null, outboundCount: 0, revision: session.revision + 1, reactivatedByUid: actor.uid });
    return clone(session);
  }
}

function inbound(id, timestamp = "100", body = "hola", from = "5491111111111") {
  return { id, timestamp, from, type: "text", text: { body } };
}

function runtimeFixture({ repository = new MemoryRepository(), senderResult = { ok: true, messageId: "wamid.out" }, config = {} } = {}) {
  const calls = [];
  const sender = { async send(payload) { calls.push(clone(payload)); return typeof senderResult === "function" ? senderResult(payload, calls.length) : clone(senderResult); } };
  const runtime = createChatbotRuntime({
    repository,
    sender,
    config: {
      runtimeEnabled: true,
      sendEnabled: true,
      allowedPhoneIds: new Set(["phone_1"]),
      maxOutboundPerSession: 20,
      maxOutboundPerMinute: 10,
      maxSendAttempts: 3,
      ...config,
    },
    now: () => 200_000,
  });
  return { repository, runtime, calls };
}

test("un mensaje duplicado no avanza ni envía dos veces", async () => {
  const { runtime, repository, calls } = runtimeFixture();
  const first = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  const duplicate = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  assert.equal(first.kind, "processed");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(calls.length, 2);
  assert.equal(repository.sessions.get("phone_1__5491111111111").revision, 1);
});

test("rechaza mensajes fuera de orden sin cambiar la sesión", async () => {
  const { runtime, repository } = runtimeFixture();
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1", "200") });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m0", "100", "respuesta") });
  assert.equal(result.reason, "OUT_OF_ORDER");
  assert.equal(repository.sessions.get("phone_1__5491111111111").revision, 1);
});

test("serializa conversaciones simultáneas mediante revisión optimista", async () => {
  const { runtime, repository } = runtimeFixture();
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("start", "100") });
  const results = await Promise.all([
    runtime.processInbound({ phoneId: "phone_1", message: inbound("m2", "101", "software") }),
    runtime.processInbound({ phoneId: "phone_1", message: inbound("m3", "102", "Córdoba") }),
  ]);
  assert.deepEqual(results.map((item) => item.kind), ["processed", "processed"]);
  const session = repository.sessions.get("phone_1__5491111111111");
  assert.equal(session.revision, 3);
  assert.equal(session.status, "READY_FOR_HUMAN");
});

test("un error definitivo de envío suspende el bot", async () => {
  const { runtime, repository } = runtimeFixture({ senderResult: { ok: false, code: "META_SEND_ERROR", message: "HTTP 400", retryable: false } });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  assert.equal(result.delivery.kind, "failed");
  const session = repository.sessions.get("phone_1__5491111111111");
  assert.equal(session.status, "ERROR");
  assert.equal(session.transferReason, "SEND_ERROR");
});

test("un reintento parcial continúa desde el mensaje pendiente", async () => {
  const senderResult = (_payload, callNumber) => callNumber === 2
    ? { ok: false, code: "TEMPORARY", message: "temporal", retryable: true }
    : { ok: true, messageId: `out_${callNumber}` };
  const { runtime, calls, repository } = runtimeFixture({ senderResult });
  const message = inbound("retry1");
  assert.equal((await runtime.processInbound({ phoneId: "phone_1", message })).delivery.kind, "retry");
  assert.equal((await runtime.processInbound({ phoneId: "phone_1", message })).delivery.kind, "sent");
  assert.deepEqual(calls.map((item) => item.intent.body), ["Hola", "¿Qué necesitás?", "¿Qué necesitás?"]);
  assert.equal([...repository.outboxes.values()][0].status, "sent");
});

test("una respuesta del vendedor suspende una sesión y es idempotente", async () => {
  const { runtime, repository } = runtimeFixture();
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  const echo = { id: "echo1", to: "5491111111111", timestamp: "101" };
  assert.equal((await runtime.processHumanEcho({ phoneId: "phone_1", echo })).kind, "suspended");
  assert.equal((await runtime.processHumanEcho({ phoneId: "phone_1", echo })).kind, "duplicate");
  assert.equal(repository.sessions.get("phone_1__5491111111111").status, "HUMAN_ACTIVE");
});

test("la palabra configurada transfiere anticipadamente a humano", async () => {
  const { runtime, repository } = runtimeFixture();
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m2", "101", "quiero vendedor") });
  assert.equal(result.status, "READY_FOR_HUMAN");
  assert.equal(repository.sessions.get("phone_1__5491111111111").transferReason, "CUSTOMER_REQUESTED_HUMAN");
  assert.equal(repository.conversations.get("phone_1__5491111111111").chatbotTransferReason, "CUSTOMER_REQUESTED_HUMAN");
});

test("una solicitud humana en el primer mensaje no inicia preguntas", async () => {
  const { runtime, repository, calls } = runtimeFixture();
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1", "100", "vendedor") });
  assert.equal(result.status, "READY_FOR_HUMAN");
  assert.deepEqual(calls.map((item) => item.intent.body), ["Hola", "Te derivamos"]);
  assert.equal(repository.sessions.get("phone_1__5491111111111").transferReason, "CUSTOMER_REQUESTED_HUMAN");
});

test("la reactivación exige administrador y revisión exacta", async () => {
  const { runtime, repository } = runtimeFixture();
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  await runtime.processHumanEcho({ phoneId: "phone_1", echo: { id: "e1", to: "5491111111111", timestamp: "101" } });
  const revision = repository.sessions.get("phone_1__5491111111111").revision;
  await assert.rejects(() => runtime.reactivateSession({ actor: { uid: "seller", email: "seller@test" }, conversationId: "phone_1__5491111111111", expectedRevision: revision }), /administrativo/i);
  const session = await runtime.reactivateSession({ actor: { isAdmin: true, uid: "admin", email: "admin@test" }, conversationId: "phone_1__5491111111111", expectedRevision: revision });
  assert.equal(session.status, "BOT_PENDING");
  assert.equal(session.botSuspended, false);
});

test("rechaza número no autorizado", async () => {
  const { runtime } = runtimeFixture();
  const result = await runtime.processInbound({ phoneId: "otro", message: inbound("m1") });
  assert.equal(result.reason, "PHONE_NOT_ALLOWED");
});

test("no inicia cuando no existe un flujo publicado y habilitado", async () => {
  const repository = new MemoryRepository();
  repository.published = null;
  const { runtime } = runtimeFixture({ repository });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  assert.equal(result.reason, "FLOW_DISABLED");
});

test("no responde a un contacto excluido o personal", async () => {
  const repository = new MemoryRepository();
  repository.conversations.set("phone_1__5491111111111", { chatbotCommercialEligible: true, chatbotExcluded: true });
  const { runtime, calls } = runtimeFixture({ repository });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  assert.equal(result.reason, "CONTACT_NOT_ELIGIBLE");
  assert.equal(calls.length, 0);
});

test("el límite de mensajes deriva a humano sin enviar", async () => {
  const { runtime, repository, calls } = runtimeFixture({ config: { maxOutboundPerSession: 1 } });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  assert.equal(result.limitReached, true);
  assert.equal(calls.length, 0);
  assert.equal(repository.sessions.get("phone_1__5491111111111").transferReason, "MESSAGE_LIMIT");
});

test("al completar conserva una asignación manual y persiste respuestas estructuradas", async () => {
  const repository = new MemoryRepository();
  repository.published.seller = { uid: "seller-default", email: "default@example.com" };
  repository.conversations.get("phone_1__5491111111111").assignedToUid = "seller-manual";
  repository.conversations.get("phone_1__5491111111111").assignedToEmail = "manual@example.com";
  const { runtime } = runtimeFixture({ repository });
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1") });
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m2", "101", "software") });
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m3", "102", "Córdoba") });
  const conversation = repository.conversations.get("phone_1__5491111111111");
  assert.equal(conversation.assignedToUid, "seller-manual");
  assert.equal(conversation.chatbotFormCompleted, true);
  assert.equal(conversation.chatbotAnswers.need.value, "software");
  assert.equal(conversation.chatbotAnswers.city.value, "Córdoba");
});

test("la transferencia asigna el vendedor configurado solo cuando no hay asignación previa", async () => {
  const repository = new MemoryRepository();
  repository.published.seller = { uid: "seller-default", email: "default@example.com" };
  const { runtime } = runtimeFixture({ repository });
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m1", "100", "vendedor") });
  const conversation = repository.conversations.get("phone_1__5491111111111");
  assert.equal(conversation.assignedToUid, "seller-default");
  assert.equal(conversation.assignedToEmail, "default@example.com");
});

test("sin vendedor válido la transferencia queda sin asignación para gestión administrativa", async () => {
  const repository = new MemoryRepository();
  const { runtime } = runtimeFixture({ repository });
  await runtime.processInbound({ phoneId: "phone_1", message: inbound("m-no-seller", "100", "vendedor") });
  const conversation = repository.conversations.get("phone_1__5491111111111");
  assert.equal(conversation.assignedToUid, undefined);
  assert.equal(conversation.chatbotStatus, "READY_FOR_HUMAN");
});

test("una toma humana durante un envío cancela los mensajes siguientes", async () => {
  const repository = new MemoryRepository();
  let runtime;
  let calls = 0;
  const sender = { async send() {
    calls += 1;
    if (calls === 1) await runtime.processHumanEcho({ phoneId: "phone_1", echo: { id: "echo-race", to: "5491111111111", timestamp: "101" } });
    return { ok: true, messageId: `out-${calls}` };
  } };
  runtime = createChatbotRuntime({ repository, sender, config: { runtimeEnabled: true, sendEnabled: true, allowedPhoneIds: new Set(["phone_1"]), maxOutboundPerSession: 20, maxOutboundPerMinute: 10, maxSendAttempts: 3 }, now: () => 200_000 });
  const result = await runtime.processInbound({ phoneId: "phone_1", message: inbound("race") });
  assert.equal(result.delivery.kind, "cancelled");
  assert.equal(calls, 1);
  assert.equal(repository.sessions.get("phone_1__5491111111111").status, "HUMAN_ACTIVE");
});

test("el remitente permanece inerte sin flags y no llama a Meta", async () => {
  let fetchCalls = 0;
  const sender = createChatbotSender({ fetchImpl: async () => { fetchCalls += 1; throw new Error("no debería ejecutarse"); }, env: {} });
  const result = await sender.send({ phoneId: "phone_1", recipient: "+5491111111111", intent: { type: "text", body: "Hola" }, lastCustomerMessageAtMs: Date.now() });
  assert.equal(result.code, "SEND_DISABLED");
  assert.equal(fetchCalls, 0);
});

test("el remitente rechaza mensajes libres fuera de la ventana de 24 horas", async () => {
  let fetchCalls = 0;
  const sender = createChatbotSender({
    fetchImpl: async () => { fetchCalls += 1; throw new Error("no debería ejecutarse"); },
    now: () => 200_000_000,
    env: {
      CHATBOT_RUNTIME_ENABLED: "true",
      CHATBOT_SEND_ENABLED: "true",
      CHATBOT_ALLOWED_PHONE_IDS: "phone_1",
      CHATBOT_META_TOKENS_JSON: JSON.stringify({ phone_1: "secret" }),
      META_GRAPH_API_VERSION: "v27.0",
    },
  });
  const result = await sender.send({ phoneId: "phone_1", recipient: "+5491111111111", intent: { type: "text", body: "Hola" }, lastCustomerMessageAtMs: 1 });
  assert.equal(result.code, "WINDOW_CLOSED");
  assert.equal(fetchCalls, 0);
});

test("construye payloads permitidos sin exponer tokens", () => {
  const payload = buildChatbotGraphPayload({ type: "buttons", body: "Elegí", options: [
    { id: "one", label: "Uno", value: "1" },
    { id: "two", label: "Dos", value: "2" },
  ] }, "+54 9 11 1111 1111");
  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.action.buttons.length, 2);
  assert.equal(payload.to, "5491111111111");
});
