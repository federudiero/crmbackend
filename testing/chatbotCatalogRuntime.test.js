import test from "node:test";
import assert from "node:assert/strict";
import { createChatbotRuntime } from "../lib/chatbotRuntime.js";

function flow() {
  return {
    name: "Venta catálogo", startQuestionId: "sku", maxAttempts: 3,
    transfer: { humanKeywords: ["asesor"], onComplete: true, message: "Coordinación con vendedor" },
    confirmation: { enabled: true, prompt: "¿Confirmás la solicitud?", confirmLabel: "Confirmar datos", editLabel: "Modificar datos" },
    catalogQuote: { enabled: true, skuAnswerKey: "sku", quantityAnswerKey: "qty" },
    questions: [
      { id: "sku", key: "sku", prompt: "Producto", type: "list", required: true, options: [{ id: "o1", label: "Látex 20L", value: "LATEX20" }], nextQuestionId: "qty" },
      { id: "qty", key: "qty", prompt: "Cantidad", type: "number", required: true, validation: { min: 1, max: 100 } },
    ],
  };
}
function fixture(flowDefinition = flow()) {
  const state = { session: null, conversation: { chatbotCommercialEligible: true }, orders: [], intents: [] };
  const assigned = { id: "cba", revision: 1, active: true, currency: "ARS", products: [{ sku: "LATEX20", name: "Látex", presentation: "20L", price: 34000 }] };
  const repository = {
    async getConversation() { return state.conversation; },
    async getPublishedFlow() { return { id: "flow1", version: 1, flow: flowDefinition, seller: null }; },
    async getSession() { return state.session; },
    async getAssignedCatalog() { return assigned; },
    async commitInbound({ session, expectedRevision, transfer, outbox }) {
      if ((state.session?.revision || 0) !== expectedRevision) return { kind: "conflict" };
      state.session = { ...structuredClone(session), revision: expectedRevision + 1 };
      if (transfer?.orderConfirmed) state.orders.push(structuredClone(transfer));
      if (outbox) state.intents.push(...structuredClone(outbox.intents));
      return { kind: "committed", outboxId: outbox?.id || null };
    },
  };
  const runtime = createChatbotRuntime({ repository, config: { runtimeEnabled: true, sendEnabled: false,
    allowedPhoneIds: new Set(["1234567890"]), maxOutboundPerSession: 30, maxOutboundPerMinute: 20, maxSendAttempts: 3 }, now: () => 100000 });
  async function inbound(id, body, timestamp = "101") {
    return runtime.processInbound({ phoneId: "1234567890", message: { id, from: "5491111111111", timestamp, type: "text", text: { body } } });
  }
  return { inbound, state, assigned };
}

test("ofrece subtotal verificable antes de pedir confirmación y conserva snapshot", async () => {
  const f = fixture();
  await f.inbound("m1", "hola");
  await f.inbound("m2", "LATEX20", "102");
  await f.inbound("m3", "2", "103");
  assert.equal(f.state.session.state.catalogEstimate.subtotal, 68000);
  assert.ok(f.state.intents.some((i) => i.body?.includes("68.000")));
  assert.ok(f.state.intents.some((i) => i.body?.includes("No incluye envío")));
  assert.ok(f.state.intents.every((i) => i.type !== "buttons" || i.body.length <= 1024));
  await f.inbound("m4", "confirmar_pedido", "104");
  assert.equal(f.state.orders.length, 1);
  assert.equal(f.state.orders[0].catalogEstimate.subtotal, 68000);
  assert.equal(f.state.orders[0].orderConfirmed, true);
});

test("si cambia el precio luego del presupuesto deriva al vendedor sin confirmar", async () => {
  const f = fixture();
  await f.inbound("m1", "hola");
  await f.inbound("m2", "LATEX20", "102");
  await f.inbound("m3", "2", "103");
  f.assigned.revision++;
  f.assigned.products[0].price = 35500;
  const result = await f.inbound("m4", "confirmar_pedido", "104");
  assert.equal(result.status, "READY_FOR_HUMAN");
  assert.equal(f.state.session.transferReason, "PRICE_CHANGED");
  assert.equal(f.state.orders.length, 0);
});

test("si no existe el SKU válido transfiere sin fabricar importe", async () => {
  const f = fixture();
  await f.inbound("m1", "hola");
  await f.inbound("m2", "LATEX20", "102");
  f.assigned.products[0].active = false;
  const result = await f.inbound("m3", "2", "103");
  assert.equal(result.status, "READY_FOR_HUMAN");
  assert.equal(f.state.session.transferReason, "QUOTE_UNAVAILABLE");
  assert.equal(f.state.orders.length, 0);
});


test("carrito de dos productos genera subtotal y pedido confirmado con líneas independientes", async () => {
  const flowWithCart = {
    name: "Carrito", startQuestionId: "sku1", maxAttempts: 3,
    confirmation: { enabled: true, prompt: "¿Confirmás?", confirmLabel: "Confirmar datos", editLabel: "Modificar datos" },
    transfer: { humanKeywords: ["asesor"], onComplete: true, message: "Coordinar" },
    catalogQuote: { enabled: true, items: [
      { skuAnswerKeys: ["sku1"], quantityAnswerKey: "qty1" },
      { skuAnswerKeys: ["sku2"], quantityAnswerKey: "qty2" },
    ] },
    questions: [
      { id: "sku1", key: "sku1", prompt: "Producto 1", type: "list", options: [{ id: "a", label: "Látex", value: "LATEX20" }], nextQuestionId: "qty1" },
      { id: "qty1", key: "qty1", prompt: "Cantidad 1", type: "number", nextQuestionId: "sku2" },
      { id: "sku2", key: "sku2", prompt: "Producto 2", type: "list", options: [{ id: "b", label: "Membrana", value: "MEM20" }], nextQuestionId: "qty2" },
      { id: "qty2", key: "qty2", prompt: "Cantidad 2", type: "number" },
    ],
  };
  const f = fixture(flowWithCart);
  f.assigned.products.push({ sku: "MEM20", name: "Membrana", presentation: "20 L", price: 39000, active: true });
  await f.inbound("cart1", "hola");
  await f.inbound("cart2", "LATEX20", "102");
  await f.inbound("cart3", "2", "103");
  await f.inbound("cart4", "MEM20", "104");
  await f.inbound("cart5", "1", "105");
  assert.equal(f.state.session.state.catalogEstimate.items.length, 2);
  assert.equal(f.state.session.state.catalogEstimate.subtotal, 107000);
  assert.ok(f.state.intents.some((intent) => intent.body?.includes("107.000")));
  await f.inbound("cart6", "confirmar_pedido", "106");
  assert.equal(f.state.orders.length, 1);
  assert.equal(f.state.orders[0].catalogEstimate.items[1].sku, "MEM20");
});

test("cambio de precio en segunda línea suspende confirmación y transfiere al humano", async () => {
  const custom = {
    ...flow(), catalogQuote: { enabled: true, items: [{ skuAnswerKeys: ["sku"], quantityAnswerKey: "qty" }] },
  };
  const f = fixture(custom);
  await f.inbound("p1", "hola");
  await f.inbound("p2", "LATEX20", "102");
  await f.inbound("p3", "2", "103");
  f.assigned.products[0].price = 35500;
  const result = await f.inbound("p4", "confirmar_pedido", "104");
  assert.equal(result.status, "READY_FOR_HUMAN");
  assert.equal(f.state.orders.length, 0);
});
