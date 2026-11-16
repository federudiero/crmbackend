import test from "node:test";
import assert from "node:assert/strict";
import { groupUniqueZonePhones, buildExcelAnalytics } from "../lib/crmExcelAnalytics.js";

test("cuenta números únicos por localidad sin reutilizar WABA", () => {
  const result = groupUniqueZonePhones([
    { id: "a", phone: "+54 9 351 111-1111", zone: "Córdoba", crmCustomerZone: "Alta Gracia" },
    { id: "b", phone: "+54 9 351 111-1111", zone: "Córdoba", crmCustomerZone: "Alta Gracia" },
    { id: "c", phone: "+54 9 351 222-2222", zone: "Córdoba" },
  ]);
  assert.equal(result.uniqueNumbers, 2);
  assert.equal(result.summary.find((r) => r.key === "Alta Gracia").uniqueNumbers, 1);
  assert.equal(result.summary.find((r) => r.key === "Alta Gracia").conversations, 2);
  assert.equal(result.summary.find((r) => r.key === "Sin identificar").uniqueNumbers, 1);
});

test("un mismo teléfono con zonas contradictorias no se cuenta dos veces", () => {
  const result = groupUniqueZonePhones([
    { id: "a", phone: "5493511234567", crmCustomerZone: "Alta Gracia" },
    { id: "b", phone: "5493511234567", crmCustomerZone: "Villa María" },
  ]);
  assert.equal(result.uniqueNumbers, 1);
  assert.equal(result.summary.find((r) => r.key === "Zona por revisar").uniqueNumbers, 1);
  assert.equal(result.byZone.get("Zona por revisar").length, 1);
});

test("no interpreta como venta a un contacto sin nueva clasificación", () => {
  const result = buildExcelAnalytics([{ phone: "5493511234567", gestionStatus: "vendido" }]);
  assert.equal(result.total, 1);
  assert.equal(result.classified, 0);
  assert.equal(result.unclassified, 1);
  assert.equal(result.outcome.find((r) => r.key === "Vendido").count, 0);
  assert.equal(result.withoutStage, 1);
});

test("el embudo considera las etapas alcanzadas y sus posteriores", () => {
  const result = buildExcelAnalytics([
    { crmQualification: "Calificado", crmStage: "Venta cerrada", crmOutcome: "Vendido" },
    { crmQualification: "No calificado", crmUnqualifiedReason: "Fuera de zona", crmStage: "Contactado", crmOutcome: "Perdido", crmOutcomeReason: "Precio" },
    { crmQualification: "Sin calificar", crmOutcome: "Activo" },
  ]);
  assert.equal(result.qualified, 1);
  assert.equal(result.unqualified, 1);
  assert.equal(result.stages[0].reached, 2);
  assert.equal(result.stages[1].reached, 2);
  assert.equal(result.stages.at(-1).reached, 1);
  assert.equal(result.unqualifiedReasons[0].key, "Fuera de zona");
  assert.equal(result.outcomeReasons[0].key, "Precio");
});
