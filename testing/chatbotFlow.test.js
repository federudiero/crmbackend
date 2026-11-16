import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceSimulation,
  createSimulation,
  simulateFlow,
  validateFlowDefinition,
} from "../lib/chatbotFlow.js";
import { simulateChatbotFlow, validateChatbotFlow } from "../lib/crmManagement.js";

const baseFlow = {
  id: "ventas_cordoba",
  name: "Consulta comercial",
  welcomeMessage: "Hola. Voy a hacerte unas preguntas breves.",
  closingMessage: "Ya registré tus datos.",
  invalidMessage: "Respuesta inválida.",
  maxAttempts: 2,
  startQuestionId: "producto",
  transfer: {
    onComplete: true,
    humanKeywords: ["vendedor", "persona"],
    message: "Te paso con un vendedor.",
  },
  questions: [
    {
      id: "producto",
      key: "producto",
      prompt: "¿Qué producto te interesa?",
      type: "buttons",
      options: [
        { id: "a", label: "Producto A", value: "producto_a", nextQuestionId: "cantidad" },
        { id: "b", label: "Producto B", value: "producto_b", nextQuestionId: "ubicacion" },
      ],
    },
    {
      id: "cantidad",
      key: "cantidad",
      prompt: "¿Qué cantidad necesitás?",
      type: "number",
      validation: { min: 1, max: 1000 },
      nextQuestionId: "ubicacion",
    },
    {
      id: "ubicacion",
      key: "ubicacion",
      prompt: "Compartí la ubicación de entrega.",
      type: "location",
    },
  ],
};

test("valida y normaliza un flujo comercial sin valores de negocio inventados", () => {
  const result = validateFlowDefinition(baseFlow);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.flow.schemaVersion, 1);
  assert.equal(result.flow.questions[0].options[0].value, "producto_a");
});

test("simula bifurcación, respuestas estructuradas y transferencia al completar", () => {
  const result = simulateFlow(baseFlow, ["a", "12", { latitude: -31.42, longitude: -64.18, name: "Córdoba" }]);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "READY_FOR_HUMAN");
  assert.equal(result.state.transferReason, "FLOW_COMPLETED");
  assert.equal(result.state.answers.producto.value, "producto_a");
  assert.equal(result.state.answers.cantidad.value, 12);
  assert.deepEqual(result.state.answers.ubicacion.value, {
    latitude: -31.42,
    longitude: -64.18,
    name: "Córdoba",
  });
  assert.equal(result.state.messages.some((item) => item.kind === "transfer"), true);
});

test("una opción puede saltar preguntas no aplicables", () => {
  const result = simulateFlow(baseFlow, ["producto_b"]);
  assert.equal(result.state.status, "WAITING_FOR_CUSTOMER");
  assert.equal(result.state.currentQuestionId, "ubicacion");
  assert.equal(Object.hasOwn(result.state.answers, "cantidad"), false);
});

test("transfiere luego del máximo de intentos inválidos", () => {
  const result = simulateFlow(baseFlow, ["opcion_inexistente", "otra_opcion"]);
  assert.equal(result.state.status, "READY_FOR_HUMAN");
  assert.equal(result.state.transferReason, "MAX_ATTEMPTS");
  assert.deepEqual(result.state.answers, {});
});

test("la solicitud de una persona suspende el flujo antes de guardar la respuesta", () => {
  const validation = validateFlowDefinition(baseFlow);
  let state = createSimulation(validation.flow);
  state = advanceSimulation(validation.flow, state, "Quiero hablar con un vendedor");
  assert.equal(state.status, "READY_FOR_HUMAN");
  assert.equal(state.transferReason, "CUSTOMER_REQUESTED_HUMAN");
  assert.deepEqual(state.answers, {});
});

test("rechaza destinos inexistentes, ciclos y patrones de validación riesgosos", () => {
  const result = validateFlowDefinition({
    name: "Inválido",
    startQuestionId: "uno",
    questions: [
      {
        id: "uno",
        key: "uno",
        prompt: "Uno",
        type: "text",
        validation: { pattern: "^(a+)+$" },
        nextQuestionId: "dos",
      },
      { id: "dos", key: "dos", prompt: "Dos", type: "text", nextQuestionId: "uno" },
      { id: "tres", key: "tres", prompt: "Tres", type: "text", nextQuestionId: "no_existe" },
    ],
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.code === "unsafe"), true);
  assert.equal(result.errors.some((item) => item.code === "cycle"), true);
  assert.equal(result.errors.some((item) => item.code === "target_not_found"), true);
  assert.equal(result.warnings.some((item) => item.code === "unreachable"), true);
});

test("limita botones al máximo admitido por WhatsApp sin limitar listas válidas", () => {
  const buttons = structuredClone(baseFlow);
  buttons.questions[0].options = [1, 2, 3, 4].map((value) => ({
    id: `option_${value}`,
    label: `Opción ${value}`,
    value: String(value),
    nextQuestionId: "cantidad",
  }));
  assert.equal(validateFlowDefinition(buttons).errors.some((item) => item.message.includes("hasta 3 botones")), true);

  const longLabel = structuredClone(baseFlow);
  longLabel.questions[0].options[0].label = "Una etiqueta demasiado larga";
  assert.equal(validateFlowDefinition(longLabel).errors.some((item) => item.path.endsWith(".label")), true);

  const list = structuredClone(buttons);
  list.questions[0].type = "list";
  assert.equal(validateFlowDefinition(list).valid, true);
});

test("las acciones del endpoint CRM son exclusivamente administrativas", () => {
  assert.throws(
    () => validateChatbotFlow({ isAdmin: false }, { flow: baseFlow }),
    (error) => error?.statusCode === 403
  );
  assert.throws(
    () => simulateChatbotFlow({ isAdmin: false }, { flow: baseFlow, responses: [] }),
    (error) => error?.statusCode === 403
  );
  assert.equal(validateChatbotFlow({ isAdmin: true }, { flow: baseFlow }).chatbot.valid, true);
  assert.equal(
    simulateChatbotFlow({ isAdmin: true }, { flow: baseFlow, responses: [] }).chatbot.state.status,
    "WAITING_FOR_CUSTOMER"
  );
});
