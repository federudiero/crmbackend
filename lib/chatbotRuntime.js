import { createHash } from "node:crypto";
import { advanceSimulation, chatbotFlowInternals, createSimulation, validateFlowDefinition } from "./chatbotFlow.js";
import { buildScopedConversationId, normalizeE164AR } from "./conversationScope.js";
import { createChatbotSender } from "./chatbotSender.js";
import { createFirestoreChatbotRuntimeStore, chatbotRuntimeStoreInternals } from "./chatbotRuntimeStore.js";

const TERMINAL_STATES = new Set(["READY_FOR_HUMAN", "HUMAN_ACTIVE", "COMPLETED", "CANCELLED", "ERROR"]);

function integer(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function configFromEnv(env = process.env) {
  return {
    runtimeEnabled: env.CHATBOT_RUNTIME_ENABLED === "true",
    sendEnabled: env.CHATBOT_SEND_ENABLED === "true",
    allowedPhoneIds: new Set(String(env.CHATBOT_ALLOWED_PHONE_IDS || "").split(",").map((item) => item.trim()).filter(Boolean)),
    maxOutboundPerSession: integer(env.CHATBOT_MAX_MESSAGES_PER_SESSION, 20, 1, 100),
    maxOutboundPerMinute: integer(env.CHATBOT_MAX_MESSAGES_PER_MINUTE, 10, 1, 100),
    maxSendAttempts: integer(env.CHATBOT_MAX_SEND_ATTEMPTS, 3, 1, 5),
  };
}

function documentId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 40)}`;
}

function timestampMs(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : fallback;
}

function extractInboundAnswer(message) {
  if (message?.type === "text") return message?.text?.body ?? null;
  if (message?.type === "button") return message?.button?.payload || message?.button?.text || null;
  if (message?.type === "interactive") {
    return message?.interactive?.button_reply?.id || message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.id || message?.interactive?.list_reply?.title || null;
  }
  if (message?.type === "location") {
    return {
      latitude: message?.location?.latitude,
      longitude: message?.location?.longitude,
      name: message?.location?.name || null,
    };
  }
  if (message?.type === "contacts") {
    const contact = Array.isArray(message.contacts) ? message.contacts[0] : null;
    const phone = contact?.phones?.[0]?.wa_id || contact?.phones?.[0]?.phone || "";
    const name = contact?.name?.formatted_name || [contact?.name?.first_name, contact?.name?.last_name].filter(Boolean).join(" ");
    return { phone, name: name || null };
  }
  return null;
}

function compactState(state) {
  if (!state) return null;
  const { messages: _messages, ...rest } = state;
  return rest;
}

function stateForEngine(state) {
  return { ...(state || {}), messages: [] };
}

function outboundIntents(flow, messages) {
  const questions = new Map((flow.questions || []).map((question) => [question.id, question]));
  return (messages || []).map((message) => {
    const question = message.questionId ? questions.get(message.questionId) : null;
    if (message.kind === "question" && question?.type === "buttons") {
      return { type: "buttons", body: message.body, options: question.options.map(({ id, label, value }) => ({ id, label, value })) };
    }
    if (message.kind === "question" && question?.type === "list") {
      return { type: "list", body: message.body, options: question.options.map(({ id, label, value }) => ({ id, label, value })) };
    }
    return { type: "text", body: message.body };
  }).filter((intent) => intent.body);
}

function commercialConversation(conversation) {
  return Boolean(conversation) && conversation.chatbotCommercialEligible === true && conversation.chatbotExcluded !== true && conversation.chatbotPersonal !== true;
}

export function createChatbotRuntime({
  repository = createFirestoreChatbotRuntimeStore(),
  sender = createChatbotSender(),
  config = configFromEnv(),
  now = () => Date.now(),
} = {}) {
  async function dispatchOutbox(outboxId) {
    if (!outboxId || !config.sendEnabled) return { kind: "queued", outboxId };
    const outbox = await repository.claimOutbox(outboxId, now(), config.maxSendAttempts, config.maxOutboundPerMinute);
    if (!outbox) return { kind: "not_claimed", outboxId };
    const results = Array.isArray(outbox.results) ? [...outbox.results] : [];
    const startIndex = Math.max(0, Number(outbox.nextIntentIndex) || 0);
    for (let index = startIndex; index < (outbox.intents || []).length; index += 1) {
      const intent = outbox.intents[index];
      const result = await sender.send({
        phoneId: outbox.phoneId,
        recipient: outbox.recipient,
        intent,
        lastCustomerMessageAtMs: outbox.lastCustomerMessageAtMs,
      });
      results.push(result);
      if (!result.ok) {
        const final = !result.retryable || outbox.attempts >= (outbox.maxSendAttempts || config.maxSendAttempts);
        await repository.markOutboxFailed(outboxId, {
          retryable: result.retryable === true,
          code: result.code || "SEND_ERROR",
          message: result.message || "No se pudo enviar el mensaje",
          final,
          conversationId: outbox.conversationId,
        });
        return { kind: final ? "failed" : "retry", outboxId, result };
      }
      const advanced = await repository.markOutboxProgress(outboxId, index + 1, results);
      if (advanced === false) return { kind: "cancelled", outboxId, results };
    }
    const sent = await repository.markOutboxSent(outboxId, results);
    return sent === false ? { kind: "cancelled", outboxId, results } : { kind: "sent", outboxId, results };
  }

  async function processInbound({ phoneId, message }) {
    const cleanPhoneId = String(phoneId || "").trim();
    if (!config.runtimeEnabled) return { kind: "skipped", reason: "RUNTIME_DISABLED" };
    if (!config.allowedPhoneIds.has(cleanPhoneId)) return { kind: "skipped", reason: "PHONE_NOT_ALLOWED" };
    const messageId = String(message?.id || "").trim();
    const phone = normalizeE164AR(message?.from);
    const conversationId = buildScopedConversationId(phone, cleanPhoneId);
    if (!messageId || !phone || !conversationId) return { kind: "skipped", reason: "INVALID_MESSAGE" };
    const answer = extractInboundAnswer(message);
    if (answer === null) return { kind: "skipped", reason: "UNSUPPORTED_MESSAGE" };
    const occurredAtMs = timestampMs(message.timestamp, now());
    const eventId = chatbotRuntimeStoreInternals.eventDocumentId("in", messageId);

    for (let retry = 0; retry < 4; retry += 1) {
      const [conversation, published, currentSession] = await Promise.all([
        repository.getConversation(conversationId),
        repository.getPublishedFlow(cleanPhoneId),
        repository.getSession(conversationId),
      ]);
      if (!commercialConversation(conversation)) return { kind: "skipped", reason: "CONTACT_NOT_ELIGIBLE" };
      if (!published?.flow) return { kind: "skipped", reason: "FLOW_DISABLED" };
      const validation = validateFlowDefinition(published.flow);
      if (!validation.valid) return { kind: "skipped", reason: "INVALID_PUBLISHED_FLOW", errors: validation.errors };
      const flow = validation.flow;
      const revision = Math.max(0, Number(currentSession?.revision) || 0);
      if (currentSession?.botSuspended || currentSession?.status === "HUMAN_ACTIVE") {
        return { kind: "skipped", reason: "HUMAN_ACTIVE" };
      }
      if (occurredAtMs < Number(currentSession?.lastInboundAtMs || 0)) {
        return { kind: "skipped", reason: "OUT_OF_ORDER" };
      }

      let nextState;
      if (!currentSession?.state || currentSession.flowId !== published.id || currentSession.flowVersion !== published.version || currentSession.status === "BOT_PENDING") {
        nextState = createSimulation(flow);
        if (chatbotFlowInternals.humanRequested(answer, flow.transfer.humanKeywords)) {
          nextState = advanceSimulation(flow, nextState, answer);
          nextState.messages = nextState.messages.filter((message) => message.kind !== "question");
        }
      } else if (TERMINAL_STATES.has(currentSession.status)) {
        return { kind: "skipped", reason: currentSession.status };
      } else {
        nextState = advanceSimulation(flow, stateForEngine(currentSession.state), answer);
      }

      let intents = outboundIntents(flow, nextState.messages);
      const previousOutbound = Math.max(0, Number(currentSession?.outboundCount) || 0);
      const perNumberLimits = published.limits || {};
      const maxOutboundPerSession = Math.min(config.maxOutboundPerSession, Math.max(1, Number(perNumberLimits.maxMessagesPerSession) || config.maxOutboundPerSession));
      const maxOutboundPerMinute = Math.min(config.maxOutboundPerMinute, Math.max(1, Number(perNumberLimits.maxMessagesPerMinute) || config.maxOutboundPerMinute));
      const maxSendAttempts = Math.min(config.maxSendAttempts, Math.max(1, Number(perNumberLimits.maxSendAttempts) || config.maxSendAttempts));
      let limitReached = false;
      if (previousOutbound + intents.length > maxOutboundPerSession) {
        intents = [];
        limitReached = true;
        nextState.status = "READY_FOR_HUMAN";
        nextState.transferReason = "MESSAGE_LIMIT";
      }
      const terminal = TERMINAL_STATES.has(nextState.status);
      const transferring = nextState.status === "READY_FOR_HUMAN" || nextState.status === "HUMAN_ACTIVE" || nextState.status === "ERROR";
      const outboxId = intents.length ? documentId("out", messageId) : null;
      const session = {
        conversationId,
        phoneId: cleanPhoneId,
        contactPhone: phone,
        flowId: published.id,
        flowVersion: published.version,
        status: nextState.status,
        state: compactState(nextState),
        transferReason: nextState.transferReason || null,
        botSuspended: nextState.status === "READY_FOR_HUMAN" || nextState.status === "HUMAN_ACTIVE" || nextState.status === "ERROR",
        lastInboundMessageId: messageId,
        lastInboundAtMs: occurredAtMs,
        outboundCount: previousOutbound + intents.length,
        pendingOutboxIds: outboxId ? [outboxId] : [],
        defaultSeller: published.seller || currentSession?.defaultSeller || null,
        maxSendAttempts,
        maxOutboundPerMinute,
      };
      const outbox = outboxId ? {
        id: outboxId,
        conversationId,
        phoneId: cleanPhoneId,
        recipient: phone,
        status: "pending",
        attempts: 0,
        intents,
        lastCustomerMessageAtMs: occurredAtMs,
        maxSendAttempts,
        maxOutboundPerMinute,
        allowAfterTransfer: transferring,
      } : null;
      const committed = await repository.commitInbound({
        conversationId,
        eventId,
        expectedRevision: revision,
        session,
        outbox,
        cancelOutboxIds: transferring ? currentSession?.pendingOutboxIds || [] : [],
        transfer: transferring ? {
          reason: nextState.transferReason || "FLOW_COMPLETED",
          seller: published.seller || null,
          flowId: published.id,
          flowVersion: published.version,
          answers: nextState.answers || nextState.state?.answers || {},
          currentQuestionId: nextState.currentQuestionId || null,
        } : null,
      });
      if (committed.kind === "conflict") continue;
      if (committed.kind === "duplicate") {
        const delivery = await dispatchOutbox(committed.outboxId);
        return { kind: "duplicate", conversationId, delivery };
      }
      if (committed.kind !== "committed") return committed;
      const delivery = await dispatchOutbox(committed.outboxId);
      return { kind: "processed", conversationId, status: nextState.status, terminal, limitReached, delivery };
    }
    return { kind: "skipped", reason: "CONCURRENT_UPDATE" };
  }

  async function processHumanEcho({ phoneId, echo }) {
    const cleanPhoneId = String(phoneId || "").trim();
    if (!config.allowedPhoneIds.has(cleanPhoneId)) return { kind: "skipped", reason: "PHONE_NOT_ALLOWED" };
    const messageId = String(echo?.id || echo?.message_id || "").trim();
    const phone = normalizeE164AR(echo?.to || echo?.recipient_id || echo?.from);
    const conversationId = buildScopedConversationId(phone, cleanPhoneId);
    if (!messageId || !conversationId) return { kind: "skipped", reason: "INVALID_ECHO" };
    return repository.suspendForHuman({
      conversationId,
      eventId: chatbotRuntimeStoreInternals.eventDocumentId("echo", messageId),
      occurredAtMs: timestampMs(echo?.timestamp, now()),
    });
  }

  async function processWebhook(body) {
    const results = [];
    const changes = (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry) => Array.isArray(entry?.changes) ? entry.changes : []);
    for (const change of changes) {
      const value = change?.value || {};
      const phoneId = value?.metadata?.phone_number_id || "";
      if (change?.field === "smb_message_echoes") {
        for (const echo of Array.isArray(value.message_echoes) ? value.message_echoes : []) results.push(await processHumanEcho({ phoneId: echo?.phone_number_id || phoneId, echo }));
      } else if (change?.field === "messages") {
        for (const message of Array.isArray(value.messages) ? value.messages : []) results.push(await processInbound({ phoneId, message }));
      }
    }
    return { processed: results.filter((item) => item.kind === "processed").length, results };
  }

  async function reactivateSession({ actor, conversationId, expectedRevision }) {
    if (!actor?.isAdmin || !actor?.uid || !actor?.email) throw Object.assign(new Error("Acceso administrativo requerido"), { statusCode: 403 });
    if (!config.runtimeEnabled) throw Object.assign(new Error("El runtime del chatbot está deshabilitado"), { statusCode: 409 });
    const revision = Number(expectedRevision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw Object.assign(new Error("Revisión inválida"), { statusCode: 400 });
    return repository.reactivate({ conversationId: String(conversationId || "").trim(), expectedRevision: revision, actor });
  }

  return Object.freeze({ processInbound, processHumanEcho, processWebhook, dispatchOutbox, reactivateSession });
}

let defaultRuntime;
export async function processChatbotWebhook(body) {
  defaultRuntime ||= createChatbotRuntime();
  return defaultRuntime.processWebhook(body);
}

export const chatbotRuntimeInternals = Object.freeze({
  commercialConversation,
  compactState,
  configFromEnv,
  documentId,
  extractInboundAnswer,
  outboundIntents,
  timestampMs,
});
