// Métricas del Excel: módulo puro, sin dependencias de Firebase.
const cleanString = (value) => String(value ?? "").trim().slice(0, 500);
const digits = (value) => String(value || "").replace(/\D+/g, "");
function groupCount(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = cleanString(keyFn(row)) || "Sin dato";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
const CRM_STAGES = ["Nuevo", "Contactado", "Relevamiento", "Presupuesto enviado", "Datos de pago enviados", "Venta cerrada"];
const CRM_OUTCOMES = ["Activo", "Vendido", "Perdido", "Fantasma", "Congelado"];

// Desduplicación estricta por teléfono. Dos conversaciones del mismo número
// no suman dos clientes: si tienen localidades distintas, requieren revisión.
export function groupUniqueZonePhones(rows = []) {
  const byPhone = new Map();
  const conversationsByZone = new Map();
  let withoutPhone = 0;
  for (const row of rows) {
    const zone = row.crmCustomerZone || "Sin identificar";
    conversationsByZone.set(zone, (conversationsByZone.get(zone) || 0) + 1);
    const phone = digits(row.phone);
    if (!phone) { withoutPhone += 1; continue; }
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, zones: new Set(), rows: [] });
    const group = byPhone.get(phone);
    if (row.crmCustomerZone) group.zones.add(row.crmCustomerZone);
    group.rows.push(row);
  }
  const byZone = new Map();
  for (const group of byPhone.values()) {
    const zone = group.zones.size > 1 ? "Zona por revisar" : [...group.zones][0] || "Sin identificar";
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(group.rows[0]); // loadAccessibleRows ordena por última actividad
  }
  const summary = [...new Set([...byZone.keys(), ...conversationsByZone.keys()])]
    .map((key) => ({ key, uniqueNumbers: (byZone.get(key) || []).length, conversations: conversationsByZone.get(key) || 0 }))
    .sort((a, b) => b.uniqueNumbers - a.uniqueNumbers || a.key.localeCompare(b.key, "es"));
  return { summary, byZone, uniqueNumbers: byPhone.size, withoutPhone };
}

export function buildExcelAnalytics(rows = []) {
  const stages = CRM_STAGES.map((key, index) => ({
    key,
    reached: rows.filter((row) => CRM_STAGES.indexOf(row.crmStage) >= index).length,
    exact: rows.filter((row) => row.crmStage === key).length,
  }));
  const counts = (values, key) => values.map((value) => ({ key: value, count: rows.filter((row) => row[key] === value).length }));
  return {
    total: rows.length,
    classified: rows.filter((row) => Boolean(row.crmOutcome)).length,
    qualified: rows.filter((row) => row.crmQualification === "Calificado").length,
    unqualified: rows.filter((row) => row.crmQualification === "No calificado").length,
    unclassified: rows.filter((row) => !row.crmQualification || row.crmQualification === "Sin calificar").length,
    outcome: counts(CRM_OUTCOMES, "crmOutcome"),
    stages,
    withoutStage: rows.filter((row) => !row.crmStage).length,
    unqualifiedReasons: groupCount(rows.filter((row) => row.crmQualification === "No calificado" && row.crmUnqualifiedReason), (row) => row.crmUnqualifiedReason),
    outcomeReasons: groupCount(rows.filter((row) => ["Perdido", "Congelado"].includes(row.crmOutcome) && row.crmOutcomeReason), (row) => row.crmOutcomeReason),
    budgets: {
      count: rows.filter((row) => row.crmQuoteAmount !== null && row.crmQuoteAmount !== undefined && row.crmQuoteAmount !== "" && Number.isFinite(Number(row.crmQuoteAmount))).length,
      byCurrency: [...rows.reduce((map, row) => {
        const amount = Number(row.crmQuoteAmount);
        const currency = cleanString(row.crmQuoteCurrency).toUpperCase();
        if (row.crmQuoteAmount !== null && row.crmQuoteAmount !== undefined && row.crmQuoteAmount !== "" && Number.isFinite(amount) && currency) map.set(currency, (map.get(currency) || 0) + amount);
        return map;
      }, new Map()).entries()].map(([currency, amount]) => ({ currency, amount })),
    },
    confirmedRevenue: {
      count: rows.filter((row) => row.crmConfirmedRevenueAmount !== null && row.crmConfirmedRevenueAmount !== undefined && row.crmConfirmedRevenueAmount !== "" && Number.isFinite(Number(row.crmConfirmedRevenueAmount))).length,
      byCurrency: [...rows.reduce((map, row) => {
        const amount = Number(row.crmConfirmedRevenueAmount);
        const currency = cleanString(row.crmConfirmedRevenueCurrency).toUpperCase();
        if (row.crmConfirmedRevenueAmount !== null && row.crmConfirmedRevenueAmount !== undefined && row.crmConfirmedRevenueAmount !== "" && Number.isFinite(amount) && currency) map.set(currency, (map.get(currency) || 0) + amount);
        return map;
      }, new Map()).entries()].map(([currency, amount]) => ({ currency, amount })),
    },
  };
}
