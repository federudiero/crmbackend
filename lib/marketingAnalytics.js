import { digits, toMillisMaybe } from "./conversationScope.js";

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);

export function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeReferral(value = {}) {
  if (!value || typeof value !== "object") return null;
  const sourceId = clean(value.source_id || value.sourceId, 200);
  const sourceType = clean(value.source_type || value.sourceType, 80).toLowerCase();
  const sourceUrl = clean(value.source_url || value.sourceUrl, 1000);
  const headline = clean(value.headline, 500);
  const ctwaClid = clean(value.ctwa_clid || value.ctwaClid, 500);
  if (!sourceId && !sourceType && !sourceUrl && !headline && !ctwaClid) return null;
  return {
    sourceId: sourceId || null,
    sourceType: sourceType || null,
    sourceUrl: sourceUrl || null,
    headline: headline || null,
    ctwaClid: ctwaClid || null,
  };
}

export function resolveLeadAttribution(row, adsById = new Map()) {
  const referral = normalizeReferral(row?.firstReferral || row?.referral);
  const sourceId = referral?.sourceId || null;
  const ad = sourceId ? adsById.get(sourceId) : null;
  if (!ad) {
    return {
      status: "unidentified",
      evidence: referral ? "whatsapp_referral_unresolved" : "no_referral_evidence",
      sourceId,
      referral,
      accountId: null,
      campaignId: null,
      adsetId: null,
      adId: null,
    };
  }
  return {
    status: "attributed",
    evidence: "whatsapp_source_id_equals_meta_ad_id",
    sourceId,
    referral,
    accountId: ad.accountId || null,
    campaignId: ad.campaignId || null,
    campaignName: ad.campaignName || null,
    adsetId: ad.adsetId || null,
    adsetName: ad.adsetName || null,
    adId: ad.id,
    adName: ad.name || null,
  };
}

function actionSummary(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((item) => ({ type: clean(item?.action_type, 200), value: optionalNumber(item?.value) }))
    .filter((item) => item.type && item.value !== null)
    .sort((a, b) => b.value - a.value);
}

export function normalizeInsight(row = {}) {
  return {
    accountId: clean(row.account_id, 200) || null,
    accountName: clean(row.account_name, 300) || null,
    currency: clean(row.account_currency, 12).toUpperCase() || null,
    campaignId: clean(row.campaign_id, 200) || null,
    campaignName: clean(row.campaign_name, 500) || null,
    adsetId: clean(row.adset_id, 200) || null,
    adsetName: clean(row.adset_name, 500) || null,
    adId: clean(row.ad_id, 200) || null,
    adName: clean(row.ad_name, 500) || null,
    date: clean(row.date_start, 20) || null,
    spend: optionalNumber(row.spend),
    impressions: optionalNumber(row.impressions),
    reach: optionalNumber(row.reach),
    clicks: optionalNumber(row.clicks),
    uniqueClicks: optionalNumber(row.unique_clicks),
    inlineLinkClicks: optionalNumber(row.inline_link_clicks),
    ctr: optionalNumber(row.ctr),
    cpc: optionalNumber(row.cpc),
    cpm: optionalNumber(row.cpm),
    frequency: optionalNumber(row.frequency),
    actions: actionSummary(row.actions),
  };
}

const sumKnown = (rows, field) => {
  const values = rows.map((row) => optionalNumber(row[field])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};

function groupUniqueLeads(rows = []) {
  const groups = new Map();
  let missingPhone = 0;
  for (const row of rows) {
    const phone = digits(row.phone);
    if (!phone) {
      missingPhone += 1;
      groups.set(`missing:${row.id}`, [row]);
      continue;
    }
    // A single client can contact multiple business WhatsApp numbers.
    const businessPhoneId = clean(row.wabaPhoneId || row.phoneNumberId || "", 100);
    const key = `${businessPhoneId}:${phone}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const leads = [];
  for (const [phone, conversations] of groups) {
    conversations.sort((a, b) => toMillisMaybe(a.firstInboundAt || a.createdAt) - toMillisMaybe(b.firstInboundAt || b.createdAt));
    const first = conversations[0];
    const latest = conversations.at(-1);
    leads.push({
      ...latest,
      firstInboundAt: first.firstInboundAt || first.createdAt || null,
      firstReferral: first.firstReferral || first.referral || null,
      phone: phone.startsWith("missing:") ? first.phone : digits(first.phone),
      conversationIds: conversations.map((item) => item.id),
      recurring: conversations.length > 1 || Number(first.inboundMessageCount || 0) > 1,
    });
  }
  return { leads, missingPhone };
}

export function minorCurrencyAmount(value, currency) {
  const amount = optionalNumber(value);
  const code = clean(currency, 12).toUpperCase();
  if (amount === null || !code) return null;
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    return amount / (10 ** digits);
  } catch {
    return null;
  }
}

function ratio(numerator, denominator, multiplier = 1) {
  return denominator > 0 ? (numerator / denominator) * multiplier : null;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function aggregateActions(rows) {
  const totals = new Map();
  for (const row of rows) {
    for (const action of row.actions || []) totals.set(action.type, (totals.get(action.type) || 0) + action.value);
  }
  return [...totals.entries()].map(([type, value]) => ({ type, value })).sort((a, b) => b.value - a.value);
}

function sumCurrency(rows, field, currencyField = "currency") {
  const result = new Map();
  for (const row of rows) {
    const value = optionalNumber(row[field]);
    const currency = clean(row[currencyField], 12).toUpperCase();
    if (value === null || !currency) continue;
    result.set(currency, (result.get(currency) || 0) + value);
  }
  return [...result.entries()].map(([currency, amount]) => ({ currency, amount }));
}

export function buildMarketingPerformance({ contacts = [], campaigns: campaignCatalog = [], adsets = [], ads = [], insights = [], dailyInsights = [], filters = {} } = {}) {
  const adsById = new Map(ads.map((ad) => [String(ad.id), ad]));
  const normalizedInsights = insights.map(normalizeInsight);
  const { leads: allLeads, missingPhone } = groupUniqueLeads(contacts);
  let leads = allLeads.map((lead) => ({ ...lead, attribution: resolveLeadAttribution(lead, adsById) }));
  if (filters.adAccountId && filters.adAccountId !== "all") leads = leads.filter((lead) => lead.attribution.accountId === filters.adAccountId);
  if (filters.campaignId && filters.campaignId !== "all") leads = leads.filter((lead) => lead.attribution.campaignId === filters.campaignId);
  if (filters.adId && filters.adId !== "all") leads = leads.filter((lead) => lead.attribution.adId === filters.adId);

  let selectedInsights = normalizedInsights;
  if (filters.adAccountId && filters.adAccountId !== "all") selectedInsights = selectedInsights.filter((row) => row.accountId === filters.adAccountId);
  if (filters.campaignId && filters.campaignId !== "all") selectedInsights = selectedInsights.filter((row) => row.campaignId === filters.campaignId);
  if (filters.adId && filters.adId !== "all") selectedInsights = selectedInsights.filter((row) => row.adId === filters.adId);
  let selectedDailyInsights = (dailyInsights.length ? dailyInsights : insights).map(normalizeInsight);
  if (filters.adAccountId && filters.adAccountId !== "all") selectedDailyInsights = selectedDailyInsights.filter((row) => row.accountId === filters.adAccountId);
  if (filters.campaignId && filters.campaignId !== "all") selectedDailyInsights = selectedDailyInsights.filter((row) => row.campaignId === filters.campaignId);
  if (filters.adId && filters.adId !== "all") selectedDailyInsights = selectedDailyInsights.filter((row) => row.adId === filters.adId);

  const attributed = leads.filter((lead) => lead.attribution.status === "attributed");
  const qualified = leads.filter((lead) => lead.crmQualification === "Calificado");
  const unqualified = leads.filter((lead) => lead.crmQualification === "No calificado");
  const evaluated = qualified.length + unqualified.length;
  const attributedQualified = attributed.filter((lead) => lead.crmQualification === "Calificado");
  const sold = leads.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true);
  const qualifiedSold = sold.filter((lead) => lead.crmQualification === "Calificado");
  const attributedSold = attributed.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true);
  const commercialDenominator = qualified.length;
  const budgets = leads.filter((lead) => optionalNumber(lead.crmQuoteAmount) !== null);
  const confirmedRevenue = leads.filter((lead) => optionalNumber(lead.crmConfirmedRevenueAmount) !== null);
  const spendByCurrency = sumCurrency(selectedInsights, "spend");
  const quoteByCurrency = sumCurrency(budgets, "crmQuoteAmount", "crmQuoteCurrency");
  const revenueByCurrency = sumCurrency(confirmedRevenue, "crmConfirmedRevenueAmount", "crmConfirmedRevenueCurrency");
  const singleSpend = spendByCurrency.length === 1 ? spendByCurrency[0] : null;
  const singleRevenue = revenueByCurrency.length === 1 ? revenueByCurrency[0] : null;
  const attributableRevenue = confirmedRevenue.filter((lead) => lead.attribution.status === "attributed");
  const attributableRevenueByCurrency = sumCurrency(attributableRevenue, "crmConfirmedRevenueAmount", "crmConfirmedRevenueCurrency");
  const sameAttributableRevenue = singleSpend ? attributableRevenueByCurrency.find((row) => row.currency === singleSpend.currency) : null;
  const metaImpressions = sumKnown(selectedInsights, "impressions");
  // Reach is a unique-person metric; summing per-ad reach overstates account reach.
  // Preserve the ad-level figures but do not present an invented unique total.
  const metaReach = selectedInsights.length === 1 ? optionalNumber(selectedInsights[0].reach) : null;
  const metaClicks = sumKnown(selectedInsights, "clicks");
  const metaCtr = metaImpressions > 0 && metaClicks !== null ? ratio(metaClicks, metaImpressions, 100) : null;
  const metaCpc = singleSpend && metaClicks > 0 ? ratio(singleSpend.amount, metaClicks) : null;
  const metaCpm = singleSpend && metaImpressions > 0 ? ratio(singleSpend.amount, metaImpressions, 1000) : null;
  const attributedForms = attributed.filter((lead) => lead.chatbotFormCompleted === true);
  const attributedTransfers = attributed.filter((lead) => lead.chatbotTransferredAt);
  const attributedSales = attributed.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true);
  const completedFormSales = attributedForms.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true);
  const humanResponseTimes = attributedTransfers.map((lead) => {
    const start = toMillisMaybe(lead.chatbotTransferredAt);
    const end = toMillisMaybe(lead.firstSellerResponseAt);
    return start > 0 && end >= start ? (end - start) / 1000 : null;
  }).filter(Number.isFinite);

  const leadsByCampaign = groupBy(attributed, (lead) => lead.attribution.campaignId);
  const insightsByCampaign = groupBy(selectedInsights, (row) => row.campaignId);
  const filteredCatalog = campaignCatalog.filter((row) =>
    (!filters.adAccountId || filters.adAccountId === "all" || row.accountId === filters.adAccountId) &&
    (!filters.campaignId || filters.campaignId === "all" || String(row.id) === filters.campaignId) &&
    (!filters.adId || filters.adId === "all" || ads.some((ad) => ad.id === filters.adId && ad.campaignId === String(row.id)))
  );
  const campaignIds = new Set([...leadsByCampaign.keys(), ...insightsByCampaign.keys(), ...filteredCatalog.map((row) => String(row.id))]);
  const campaigns = [...campaignIds].map((campaignId) => {
    const metaRows = insightsByCampaign.get(campaignId) || [];
    const crmRows = leadsByCampaign.get(campaignId) || [];
    const campaignAds = ads.filter((ad) => ad.campaignId === campaignId && (!filters.adId || filters.adId === "all" || ad.id === filters.adId));
    const catalog = campaignCatalog.find((row) => String(row.id) === campaignId) || {};
    const spendGroups = sumCurrency(metaRows, "spend");
    const spend = spendGroups.length === 1 ? spendGroups[0].amount : null;
    const currency = spendGroups.length === 1 ? spendGroups[0].currency : clean(catalog.accountCurrency, 12).toUpperCase() || null;
    const campaignQualified = crmRows.filter((lead) => lead.crmQualification === "Calificado").length;
    const impressions = sumKnown(metaRows, "impressions");
    const clicks = sumKnown(metaRows, "clicks");
    const campaignRevenue = sumCurrency(crmRows.filter((lead) => optionalNumber(lead.crmConfirmedRevenueAmount) !== null), "crmConfirmedRevenueAmount", "crmConfirmedRevenueCurrency");
    const comparableRevenue = currency ? campaignRevenue.find((row) => row.currency === currency) : null;
    const campaignSales = crmRows.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true).length;
    const campaignForms = crmRows.filter((lead) => lead.chatbotFormCompleted === true).length;
    return {
      campaignId,
      campaignName: metaRows[0]?.campaignName || catalog.name || campaignAds[0]?.campaignName || campaignId,
      accountId: metaRows[0]?.accountId || catalog.accountId || campaignAds[0]?.accountId || null,
      status: catalog.status || campaignAds[0]?.campaignStatus || null,
      effectiveStatus: catalog.effective_status || campaignAds[0]?.campaignEffectiveStatus || null,
      currency,
      spend,
      impressions,
      reach: metaRows.length === 1 ? optionalNumber(metaRows[0].reach) : null,
      clicks,
      ctr: impressions > 0 && clicks !== null ? (clicks / impressions) * 100 : null,
      cpc: spend !== null && clicks > 0 ? spend / clicks : null,
      cpm: spend !== null && impressions > 0 ? (spend / impressions) * 1000 : null,
      dailyBudget: minorCurrencyAmount(catalog.daily_budget, currency),
      lifetimeBudget: minorCurrencyAmount(catalog.lifetime_budget, currency),
      budgetRemaining: minorCurrencyAmount(catalog.budget_remaining, currency),
      objective: catalog.objective || null,
      metaResults: aggregateActions(metaRows),
      realLeads: crmRows.length,
      qualifiedLeads: campaignQualified,
      completedForms: campaignForms,
      confirmedSales: campaignSales,
      conversionRate: ratio(campaignSales, crmRows.length, 100),
      costPerConfirmedSale: spend !== null ? ratio(spend, campaignSales) : null,
      attributableRevenue: comparableRevenue?.amount ?? null,
      roas: spend > 0 && comparableRevenue ? comparableRevenue.amount / spend : null,
      costPerRealLead: spend !== null ? ratio(spend, crmRows.length) : null,
      costPerQualifiedLead: spend !== null ? ratio(spend, campaignQualified) : null,
      contactIds: crmRows.flatMap((lead) => lead.conversationIds).slice(0, 100),
      ads: campaignAds.map((ad) => {
        const adMeta = metaRows.filter((row) => row.adId === ad.id);
        const adLeads = crmRows.filter((lead) => lead.attribution.adId === ad.id);
        const adSpendGroups = sumCurrency(adMeta, "spend");
        const adSpend = adSpendGroups.length === 1 ? adSpendGroups[0].amount : null;
        const adCurrency = adSpendGroups.length === 1 ? adSpendGroups[0].currency : null;
        const adImpressions = sumKnown(adMeta, "impressions");
        const adClicks = sumKnown(adMeta, "clicks");
        const adSales = adLeads.filter((lead) => lead.crmOutcome === "Vendido" || lead.sold === true).length;
        return { id: ad.id, name: ad.name, status: ad.status, effectiveStatus: ad.effectiveStatus, adsetId: ad.adsetId, adsetName: ad.adsetName,
          currency: adCurrency, spend: adSpend, impressions: adImpressions, reach: adMeta.length === 1 ? optionalNumber(adMeta[0].reach) : null, clicks: adClicks,
          ctr: adImpressions > 0 && adClicks !== null ? ratio(adClicks, adImpressions, 100) : null,
          cpc: adSpend !== null && adClicks > 0 ? ratio(adSpend, adClicks) : null,
          cpm: adSpend !== null && adImpressions > 0 ? ratio(adSpend, adImpressions, 1000) : null,
          metaResults: aggregateActions(adMeta), realLeads: adLeads.length,
          qualifiedLeads: adLeads.filter((lead) => lead.crmQualification === "Calificado").length,
          completedForms: adLeads.filter((lead) => lead.chatbotFormCompleted === true).length,
          confirmedSales: adSales, costPerLead: adSpend !== null ? ratio(adSpend, adLeads.length) : null,
          costPerSale: adSpend !== null ? ratio(adSpend, adSales) : null,
          contactIds: adLeads.flatMap((lead) => lead.conversationIds).slice(0, 100) };
      }),
    };
  }).sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));

  const byDayInsights = groupBy(selectedDailyInsights, (row) => row.date);
  const byDayLeads = groupBy(leads, (lead) => {
    const millis = toMillisMaybe(lead.firstInboundAt);
    const date = millis ? new Date(millis) : null;
    return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date) : null;
  });
  const days = new Set([...byDayInsights.keys(), ...byDayLeads.keys()]);
  const timeline = [...days].sort().map((date) => {
    const metaRows = byDayInsights.get(date) || [];
    const crmRows = byDayLeads.get(date) || [];
    const daySpend = sumCurrency(metaRows, "spend");
    const spend = daySpend.length === 1 ? daySpend[0].amount : null;
    const dayAttributed = crmRows.filter((lead) => lead.attribution.status === "attributed");
    return {
      date,
      currency: daySpend.length === 1 ? daySpend[0].currency : null,
      spend,
      leads: crmRows.length,
      attributedLeads: dayAttributed.length,
      qualifiedLeads: crmRows.filter((lead) => lead.crmQualification === "Calificado").length,
      costPerLead: spend !== null ? ratio(spend, dayAttributed.length) : null,
    };
  });

  return {
    definitions: {
      leadDate: "firstInboundAt del primer contacto único del período",
      spendDate: "date_start de Meta en la zona horaria de la cuenta publicitaria",
      reach: "El alcance por anuncio no es aditivo; no se calcula alcance único total sumando anuncios",
      conversionDenominator: "leads únicos calificados",
      attribution: "source_id del primer referral de WhatsApp coincide exactamente con el ID de un anuncio accesible",
    },
    metrics: {
      uniqueLeads: leads.length,
      recurringLeads: leads.filter((lead) => lead.recurring).length,
      attributedLeads: attributed.length,
      unidentifiedLeads: leads.length - attributed.length,
      qualifiedLeads: qualified.length,
      unqualifiedLeads: unqualified.length,
      evaluatedLeads: evaluated,
      attributedQualifiedLeads: attributedQualified.length,
      qualificationRate: ratio(qualified.length, evaluated, 100),
      confirmedSales: sold.length,
      conversionRate: ratio(qualifiedSold.length, commercialDenominator, 100),
      commercialDenominator,
      budgetCount: budgets.length,
      quoteByCurrency,
      confirmedRevenueCount: confirmedRevenue.length,
      revenueByCurrency,
      spendByCurrency,
      impressions: metaImpressions,
      reach: metaReach,
      clicks: metaClicks,
      ctr: metaCtr,
      cpc: metaCpc,
      cpm: metaCpm,
      metaResults: aggregateActions(selectedInsights),
      costPerLead: singleSpend ? ratio(singleSpend.amount, attributed.length) : null,
      costPerQualifiedLead: singleSpend ? ratio(singleSpend.amount, attributedQualified.length) : null,
      costPerConfirmedSale: singleSpend ? ratio(singleSpend.amount, attributedSold.length) : null,
      averageTicket: singleRevenue ? ratio(singleRevenue.amount, confirmedRevenue.length) : null,
      roas: singleSpend && sameAttributableRevenue && singleSpend.amount > 0 ? sameAttributableRevenue.amount / singleSpend.amount : null,
      monetaryCurrency: singleSpend?.currency || null,
      missingPhone,
      chatbot: {
        contacts: attributed.filter((lead) => lead.chatbotStatus || lead.chatbotFlowId).length,
        formsCompleted: attributedForms.length,
        transfers: attributedTransfers.length,
        transferErrors: attributedTransfers.filter((lead) => ["SEND_ERROR", "MAX_ATTEMPTS", "MESSAGE_LIMIT"].includes(lead.chatbotTransferReason)).length,
        pendingHuman: attributedTransfers.filter((lead) => !lead.firstSellerResponseAt).length,
        averageFirstHumanResponseSeconds: humanResponseTimes.length ? humanResponseTimes.reduce((sum, value) => sum + value, 0) / humanResponseTimes.length : null,
        contactFromClickRate: ratio(attributed.length, metaClicks, 100),
        contactToFormRate: ratio(attributedForms.length, attributed.length, 100),
        formToSaleRate: ratio(completedFormSales.length, attributedForms.length, 100),
        sales: attributedSales.length,
        lossReasons: [...groupBy(attributed.filter((lead) => lead.crmOutcomeReason), (lead) => lead.crmOutcomeReason).entries()].map(([reason, rows]) => ({ reason, count: rows.length })).sort((a, b) => b.count - a.count),
      },
    },
    campaigns,
    timeline,
    attributedContacts: attributed.slice(0, 500).map((lead) => ({
      id: lead.id || lead.conversationIds?.at(-1),
      conversationIds: lead.conversationIds,
      name: clean(lead.name, 200) || "Sin nombre",
      phone: clean(lead.phone, 40) || null,
      firstInboundAt: lead.firstInboundAt || null,
      wabaPhoneId: clean(lead.wabaPhoneId, 80) || null,
      assignedToName: clean(lead.assignedToName || lead.assignedToEmail, 200) || null,
      evidence: lead.attribution.evidence,
      accountId: lead.attribution.accountId,
      campaignId: lead.attribution.campaignId,
      campaignName: lead.attribution.campaignName,
      adId: lead.attribution.adId,
      adName: lead.attribution.adName,
      chatbotFormCompleted: lead.chatbotFormCompleted === true,
      crmQualification: lead.crmQualification || null,
      crmOutcome: lead.crmOutcome || null,
      crmOutcomeReason: lead.crmOutcomeReason || null,
    })),
  };
}
