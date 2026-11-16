import test from "node:test";
import assert from "node:assert/strict";
import { advanceSimulation, createSimulation, validateFlowDefinition, simulateFlow } from "../lib/chatbotFlow.js";

function flow() {
  return {
    name: "Confirmación comercial",
    welcomeMessage: "Hola, vamos a preparar tu solicitud",
    confirmation: { enabled: true, prompt: "Revisá tu pedido. ¿Lo confirmás?", confirmLabel: "Confirmar pedido", editLabel: "Modificar datos" },
    transfer: { onComplete: true, humanKeywords: ["asesor", "vendedor"], message: "Un asesor va a coordinar tu solicitud." },
    questions: [
      { id: "producto", key: "producto", type: "buttons", prompt: "Elegí el producto", options: [{ id: "a", label: "Opción A", value: "a" }], nextQuestionId: "nombre" },
      { id: "nombre", key: "nombre", type: "text", prompt: "¿Cómo te llamás?" },
    ],
  };
}

test("la recolección de datos no confirma un pedido automáticamente", () => {
  const result = simulateFlow(flow(), ["a", "María"]);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "WAITING_FOR_CUSTOMER");
  assert.equal(result.state.currentQuestionId, "chatbot_confirmacion_pedido");
  assert.notEqual(result.state.orderConfirmed, true);
  assert.match(result.state.messages.at(-1).body, /María/);
});

test("solo una confirmación explícita marca pedido y deriva a humano", () => {
  const result = simulateFlow(flow(), ["a", "María", "confirmar_pedido"]);
  assert.equal(result.state.status, "READY_FOR_HUMAN");
  assert.equal(result.state.transferReason, "ORDER_CONFIRMED");
  assert.equal(result.state.orderConfirmed, true);
});

test("modificar reinicia preguntas y no registra confirmación", () => {
  const result = simulateFlow(flow(), ["a", "María", "modificar_datos"]);
  assert.equal(result.state.currentQuestionId, "producto");
  assert.deepEqual(result.state.answers, {});
  assert.notEqual(result.state.orderConfirmed, true);
});

test("pedir asesor desde cualquier paso deriva sin confirmar pedido", () => {
  const result = simulateFlow(flow(), ["a", "asesor"]);
  assert.equal(result.state.transferReason, "CUSTOMER_REQUESTED_HUMAN");
  assert.notEqual(result.state.orderConfirmed, true);
});

test("flujos anteriores conservan el comportamiento sin confirmación", () => {
  const legacy = flow();
  delete legacy.confirmation;
  const validated = validateFlowDefinition(legacy);
  assert.equal(validated.flow.confirmation.enabled, false);
  assert.equal(simulateFlow(legacy, ["a", "María"]).state.transferReason, "FLOW_COMPLETED");
});

test("confirmación por defecto no se confunde con una palabra de asesor", () => {
  const validated = validateFlowDefinition(flow());
  assert.equal(validated.valid, true);
  const initial = createSimulation(validated.flow);
  assert.equal(advanceSimulation(validated.flow, initial, "Necesito un asesor").transferReason, "CUSTOMER_REQUESTED_HUMAN");
});
