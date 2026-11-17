import test from "node:test";
import assert from "node:assert/strict";
import { buildChatbotCatalogEstimate, chatbotEstimateText, sameChatbotCatalogEstimate } from "../lib/chatbotCommercialQuote.js";
import { validateFlowDefinition } from "../lib/chatbotFlow.js";

const flow = { catalogQuote: { enabled: true, skuAnswerKeys: ["sku_a", "sku_b"], quantityAnswerKey: "cantidad" } };
const catalog = { id: "catalog_cba", revision: 5, active: true, currency: "ARS", products: [
  { sku: "LATEX20", name: "Látex Premium", presentation: "20 L", price: 34000, active: true },
  { sku: "OCULTO", name: "No vendible", price: 1000, active: false },
] };

test("cotiza SKU verificable y cantidad entera desde catálogo asignado", () => {
  const estimate = buildChatbotCatalogEstimate(flow, { sku_b: { value: "LATEX20" }, cantidad: { value: 3 } }, catalog);
  assert.equal(estimate.subtotal, 102000);
  assert.equal(estimate.unitPrice, 34000);
  assert.equal(estimate.finalTotalVerified, false);
  assert.match(chatbotEstimateText(estimate), /No incluye envío/);
});

test("rechaza producto inexistente, inactivo, precio cero y cantidad decimal", () => {
  for (const sku of ["OCULTO", "NO_EXISTE"]) assert.equal(buildChatbotCatalogEstimate(flow, { sku_a: { value: sku }, cantidad: { value: 2 } }, catalog), null);
  assert.equal(buildChatbotCatalogEstimate(flow, { sku_a: { value: "LATEX20" }, cantidad: { value: 1.5 } }, catalog), null);
  assert.equal(buildChatbotCatalogEstimate(flow, { sku_a: { value: "LATEX20" }, sku_b: { value: "LATEX20" }, cantidad: { value: 2 } }, catalog), null);
  assert.equal(buildChatbotCatalogEstimate(flow, { sku_a: { value: "LATEX20" }, cantidad: { value: 1 } }, { ...catalog, active: false }), null);
});

test("una modificación del catálogo impide reutilizar una cotización antigua", () => {
  const answers = { sku_a: { value: "LATEX20" }, cantidad: { value: 2 } };
  const before = buildChatbotCatalogEstimate(flow, answers, catalog);
  const after = buildChatbotCatalogEstimate(flow, answers, { ...catalog, revision: 6, products: [{ ...catalog.products[0], price: 36000 }] });
  assert.equal(sameChatbotCatalogEstimate(before, after), false);
  assert.equal(sameChatbotCatalogEstimate(before, buildChatbotCatalogEstimate(flow, answers, catalog)), true);
});

test("el motor rechaza vinculación a pregunta de producto no seleccionable", () => {
  const input = {
    name: "Precio", startQuestionId: "p", confirmation: { enabled: true },
    catalogQuote: { enabled: true, skuAnswerKey: "sku", quantityAnswerKey: "qty" },
    questions: [
      { id: "p", key: "sku", prompt: "Producto", type: "text", nextQuestionId: "q" },
      { id: "q", key: "qty", prompt: "Cantidad", type: "number" },
    ],
  };
  assert.equal(validateFlowDefinition(input).valid, false);
  input.questions[0].type = "list";
  input.questions[0].options = [{ id: "o", value: "LATEX20", label: "Látex 20 L" }];
  assert.equal(validateFlowDefinition(input).valid, true);
});
