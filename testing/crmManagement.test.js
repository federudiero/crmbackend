import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticateCrmRequest,
  buildInboundCrmPatch,
  crmInternals,
} from "../lib/crmManagement.js";

test("la API CRM rechaza requests sin Firebase ID token", async () => {
  await assert.rejects(
    authenticateCrmRequest({ headers: {} }),
    (error) => error?.statusCode === 401 && /token/i.test(error.message)
  );
});

test("normaliza estados históricos sin inventar una venta", () => {
  assert.equal(crmInternals.normalizedStatus({}), "nuevo");
  assert.equal(crmInternals.normalizedStatus({ stage: "cerrado" }), "atendido");
  assert.equal(crmInternals.normalizedStatus({ labels: ["vendido"] }), "vendido");
  assert.equal(
    crmInternals.normalizedStatus({ gestionStatus: "en_seguimiento" }),
    "en_seguimiento"
  );
});

test("parsea smb_message_echoes con teléfono y timestamp reales", () => {
  const echo = crmInternals.parseSmbMessageEcho(
    { metadata: { phone_number_id: "123456789" } },
    {
      id: "wamid.TEST",
      to: "5493531234567",
      timestamp: "1788883200",
      type: "text",
      text: { body: "Respuesta" },
    }
  );
  assert.equal(echo.phoneId, "123456789");
  assert.equal(echo.phone, "+5493531234567");
  assert.equal(echo.messageId, "wamid.TEST");
  assert.equal(echo.text, "Respuesta");
  assert.equal(echo.occurredAt.getTime(), 1788883200000);
});

test("rechaza ecos incompletos y calcula mediana", () => {
  assert.equal(crmInternals.parseSmbMessageEcho({}, { id: "x" }), null);
  assert.equal(crmInternals.percentileMedian([60, 10, 30]), 30);
  assert.equal(crmInternals.percentileMedian([10, 20, 30, 40]), 25);
});

test("genera ids de evento compatibles con Firestore", () => {
  assert.equal(crmInternals.sanitizeEventId("meta/in echo?1"), "meta_in_echo_1");
});

test("un nuevo mensaje reabre la espera sin reutilizar una respuesta anterior", () => {
  const { patch, startsPendingCycle } = buildInboundCrmPatch({
    data: {
      gestionStatus: "atendido",
      pendingSinceAt: new Date("2026-09-08T10:00:00Z"),
      lastSellerResponseAt: new Date("2026-09-08T10:01:00Z"),
      currentCycleResponseAt: new Date("2026-09-08T10:01:00Z"),
      responseConfirmation: "webhook",
    },
    isNew: false,
    occurredAt: new Date("2026-09-08T11:00:00Z"),
    message: { id: "wamid.IN" },
    value: {},
  });
  assert.equal(startsPendingCycle, true);
  assert.equal(patch.gestionStatus, "pendiente");
  assert.equal(patch.currentCycleResponseAt, null);
  assert.equal(patch.responseConfirmation, null);
  assert.equal(crmInternals.responseIsConfirmed({ ...patch, firstSellerResponseAt: new Date() }), false);
});

test("un segundo mensaje entrante conserva el inicio del ciclo pendiente", () => {
  const pendingSinceAt = new Date("2026-09-08T10:00:00Z");
  const { patch, startsPendingCycle } = buildInboundCrmPatch({
    data: { gestionStatus: "pendiente", pendingSinceAt },
    isNew: false,
    occurredAt: new Date("2026-09-08T10:03:00Z"),
    message: { id: "wamid.IN2" },
    value: {},
  });
  assert.equal(startsPendingCycle, false);
  assert.equal(patch.gestionStatus, "pendiente");
  assert.equal(Object.hasOwn(patch, "pendingSinceAt"), false);
});

test("una respuesta confirmada calcula el tiempo desde el mensaje entrante", () => {
  const result = crmInternals.buildSellerResponseMutation({
    data: {
      gestionStatus: "pendiente",
      pendingSinceAt: new Date("2026-09-08T10:00:00Z"),
    },
    eventDate: new Date("2026-09-08T10:04:30Z"),
    sourceValue: "whatsapp_business_app",
  });
  assert.equal(result.hasOpenPendingCycle, true);
  assert.equal(result.responseSeconds, 270);
  assert.equal(result.patch.gestionStatus, "atendido");
  assert.equal(result.patch.responseConfirmation, "webhook");
  assert.equal(result.patch.firstResponseTimeSeconds, 270);
});

test("un envío proactivo no inventa atención ni tiempo de respuesta", () => {
  const result = crmInternals.buildSellerResponseMutation({
    data: { gestionStatus: "nuevo" },
    eventDate: new Date("2026-09-08T10:04:30Z"),
    sourceValue: "cloud_api",
    actorEmail: "seller@example.com",
  });
  assert.equal(result.hasOpenPendingCycle, false);
  assert.equal(result.responseSeconds, null);
  assert.equal(Object.hasOwn(result.patch, "gestionStatus"), false);
  assert.equal(Object.hasOwn(result.patch, "firstResponseTimeSeconds"), false);
});

test("las métricas usan la misma muestra y excluyen aperturas de WhatsApp", () => {
  const rows = [
    {
      id: "a",
      phone: "+5493510000001",
      gestionStatus: "vendido",
      sold: true,
      hasConfirmedResponse: true,
      firstInboundAt: new Date("2026-09-08T10:00:00Z"),
      firstSellerResponseAt: new Date("2026-09-08T10:04:00Z"),
      firstResponseTimeSeconds: 240,
      inboundMessageCount: 1,
    },
    {
      id: "b",
      phone: "+5493510000002",
      gestionStatus: "pendiente",
      sold: false,
      hasConfirmedResponse: false,
      firstInboundAt: new Date("2026-09-08T11:00:00Z"),
      inboundMessageCount: 1,
    },
  ];
  const events = [
    { type: "seller_response", conversationId: "a", responseTimeSeconds: 240, responseSource: "whatsapp_business_app" },
    { type: "whatsapp_opened", conversationId: "b" },
  ];
  const metrics = crmInternals.buildMetrics(rows, events, { start: null, end: null });
  assert.equal(metrics.contactsInPeriod, 2);
  assert.equal(metrics.sold, 1);
  assert.equal(metrics.confirmedResponses, 1);
  assert.equal(metrics.withoutResponse, 1);
  assert.equal(metrics.responseSamples, 1);
  assert.equal(metrics.responseUnder5Percent, 100);
});
