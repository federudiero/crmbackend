import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketingPerformance, normalizeInsight, resolveLeadAttribution } from "../lib/marketingAnalytics.js";
import { crmInternals, getMarketingDashboard, updateCrmEconomics } from "../lib/crmManagement.js";

const ad = {
  id: "123",
  name: "Anuncio exacto",
  accountId: "10",
  campaignId: "20",
  campaignName: "Campaña",
  adsetId: "30",
  adsetName: "Conjunto",
  status: "ACTIVE",
  effectiveStatus: "ACTIVE",
};

test("atribuye únicamente por coincidencia exacta entre source_id y ad id", () => {
  const ads = new Map([[ad.id, ad]]);
  assert.equal(resolveLeadAttribution({ firstReferral: { source_id: "123", headline: "Texto distinto" } }, ads).status, "attributed");
  assert.equal(resolveLeadAttribution({ firstReferral: { source_id: "999", headline: "Campaña" } }, ads).status, "unidentified");
  assert.equal(resolveLeadAttribution({ campaign: "Campaña" }, ads).status, "unidentified");
});

test("desduplica teléfonos y separa contactos recurrentes", () => {
  const result = buildMarketingPerformance({
    contacts: [
      { id: "a", phone: "+54 9 351 111-1111", firstInboundAt: "2026-10-01T12:00:00Z", firstReferral: { source_id: "123" }, crmQualification: "Calificado" },
      { id: "b", phone: "5493511111111", firstInboundAt: "2026-10-02T12:00:00Z", firstReferral: { source_id: "123" }, crmQualification: "Calificado" },
    ],
    ads: [ad],
  });
  assert.equal(result.metrics.uniqueLeads, 1);
  assert.equal(result.metrics.attributedLeads, 1);
  assert.equal(result.metrics.recurringLeads, 1);
});

test("calcula costos y ROAS solo con moneda compatible e ingresos confirmados", () => {
  const result = buildMarketingPerformance({
    contacts: [{
      id: "a", phone: "5493511111111", firstInboundAt: "2026-10-01T12:00:00Z",
      firstReferral: { source_id: "123" }, crmQualification: "Calificado", crmOutcome: "Vendido",
      crmQuoteAmount: 200000, crmQuoteCurrency: "ARS",
      crmConfirmedRevenueAmount: 150000, crmConfirmedRevenueCurrency: "ARS",
    }],
    ads: [ad],
    insights: [{ account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "123", date_start: "2026-10-01", spend: "30000", impressions: "1000", clicks: "50" }],
  });
  assert.equal(result.metrics.costPerLead, 30000);
  assert.equal(result.metrics.costPerQualifiedLead, 30000);
  assert.equal(result.metrics.averageTicket, 150000);
  assert.equal(result.metrics.roas, 5);
  assert.equal(result.metrics.quoteByCurrency[0].amount, 200000);
});

test("respuestas incompletas de Meta conservan métricas desconocidas como null", () => {
  const row = normalizeInsight({ account_id: "10", ad_id: "123", spend: "" });
  assert.equal(row.spend, null);
  assert.equal(row.impressions, null);
  const result = buildMarketingPerformance({ contacts: [], ads: [ad], insights: [{ account_id: "10", campaign_id: "20", ad_id: "123", date_start: "2026-10-01" }] });
  assert.equal(result.campaigns[0].spend, null);
  assert.equal(result.campaigns[0].costPerRealLead, null);
});

test("no mezcla monedas ni muestra indicadores económicos engañosos", () => {
  const result = buildMarketingPerformance({
    insights: [
      { account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "123", date_start: "2026-10-01", spend: "100" },
      { account_id: "11", account_currency: "USD", campaign_id: "21", ad_id: "124", date_start: "2026-10-01", spend: "10" },
    ],
  });
  assert.equal(result.metrics.monetaryCurrency, null);
  assert.equal(result.metrics.costPerLead, null);
  assert.equal(result.metrics.roas, null);
});

test("los filtros temporales usan inicio inclusivo y fin exclusivo", () => {
  const range = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-08T00:00:00Z") };
  assert.equal(crmInternals.matchesFilter({ firstInboundAt: new Date("2026-10-01T00:00:00Z"), labels: [] }, {}, range), true);
  assert.equal(crmInternals.matchesFilter({ firstInboundAt: new Date("2026-10-08T00:00:00Z"), labels: [] }, {}, range), false);
});

test("la consulta publicitaria rechaza vendedores antes de leer Firestore", async () => {
  await assert.rejects(getMarketingDashboard({ isAdmin: false }, {}), (error) => error?.statusCode === 403);
});

test("valida importes y fechas económicas sin aceptar negativos", () => {
  assert.equal(crmInternals.parseEconomicAmount("1234.567", "Importe"), 1234.57);
  assert.equal(crmInternals.parseEconomicAmount("", "Importe"), null);
  assert.throws(() => crmInternals.parseEconomicAmount(-1, "Importe"), (error) => error?.statusCode === 400);
  assert.throws(() => crmInternals.parseEconomicDate("1999-01-01", "Fecha"), (error) => error?.statusCode === 400);
});

test("un vendedor no puede confirmar facturación", async () => {
  await assert.rejects(
    updateCrmEconomics({ isAdmin: false }, { kind: "confirmed_revenue", amount: 1 }),
    (error) => error?.statusCode === 403
  );
});

test("traduce el fin exclusivo del CRM al until inclusivo de Meta", () => {
  const result = crmInternals.marketingRange({ start: "2026-10-01T03:00:00.000Z", end: "2026-10-08T03:00:00.000Z" });
  assert.equal(result.since, "2026-10-01");
  assert.equal(result.until, "2026-10-07");
});

test("Etapa 5: un teléfono en dos números empresariales son dos oportunidades distintas", () => {
  const result = buildMarketingPerformance({
    contacts: [
      { id: "a", phone: "5493511111111", wabaPhoneId: "111", firstInboundAt: "2026-10-01T12:00:00Z" },
      { id: "b", phone: "5493511111111", wabaPhoneId: "222", firstInboundAt: "2026-10-01T12:05:00Z" },
    ],
  });
  assert.equal(result.metrics.uniqueLeads, 2);
});

test("Etapa 5: no suma alcance único entre anuncios", () => {
  const result = buildMarketingPerformance({
    insights: [
      { account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "123", reach: "100", impressions: "150" },
      { account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "124", reach: "90", impressions: "120" },
    ],
  });
  assert.equal(result.metrics.reach, null);
  assert.equal(result.metrics.impressions, 270);
  assert.equal(result.campaigns[0].reach, null);
});

test("Etapa 5: costo por venta atribuida no exige factura cargada", () => {
  const result = buildMarketingPerformance({
    contacts: [{ id: "a", phone: "5493511231234", firstReferral: { source_id: "123" }, crmOutcome: "Vendido" }],
    ads: [ad],
    insights: [{ account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "123", spend: "500" }],
  });
  assert.equal(result.metrics.costPerConfirmedSale, 500);
  assert.equal(result.metrics.roas, null);
});

test("Etapa 5: costos, formularios y resultados por anuncio son verificables", () => {
  const result = buildMarketingPerformance({
    contacts: [{ id: "a", phone: "5493511231234", firstReferral: { source_id: "123" }, chatbotFormCompleted: true, crmOutcome: "Vendido", crmQualification: "Calificado" }],
    ads: [ad],
    insights: [{ account_id: "10", account_currency: "ARS", campaign_id: "20", ad_id: "123", date_start: "2026-10-01", spend: "600", impressions: "2000", clicks: "20", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" }] }],
  });
  const item = result.campaigns[0].ads[0];
  assert.equal(item.cpm, 300);
  assert.equal(item.cpc, 30);
  assert.equal(item.costPerLead, 600);
  assert.equal(item.completedForms, 1);
  assert.equal(item.confirmedSales, 1);
  assert.equal(item.metaResults[0].value, 4);
  assert.equal(result.attributedContacts[0].adId, "123");
});
