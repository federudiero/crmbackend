const RETRYABLE_CODES = new Set([4, 17, 32, 613, 80004]);
const CACHE = globalThis.__CRM_META_CACHE__ || new Map();
globalThis.__CRM_META_CACHE__ = CACHE;

const clean = (value, max = 1000) => String(value ?? "").trim().slice(0, max);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config() {
  const enabled = process.env.META_MARKETING_ENABLED === "true";
  const accessToken = clean(process.env.META_MARKETING_ACCESS_TOKEN, 10000);
  const apiVersion = clean(process.env.META_GRAPH_API_VERSION, 20);
  const rawAccountIds = String(process.env.META_AD_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => clean(value.replace(/^act_/, ""), 100))
    .filter(Boolean);
  const accountIds = rawAccountIds.filter((value) => /^\d{5,40}$/.test(value));
  const missing = [];
  if (!enabled) missing.push("META_MARKETING_ENABLED");
  if (!accessToken) missing.push("META_MARKETING_ACCESS_TOKEN");
  if (!apiVersion) missing.push("META_GRAPH_API_VERSION");
  if (apiVersion && !/^v\d+\.\d+$/.test(apiVersion)) missing.push("META_GRAPH_API_VERSION_FORMAT");
  if (accountIds.length !== rawAccountIds.length) missing.push("META_AD_ACCOUNT_IDS_FORMAT");
  return { enabled, accessToken, apiVersion, accountIds, missing };
}

function cacheSeconds() {
  const value = Number(process.env.META_CACHE_TTL_SECONDS || 300);
  return Number.isFinite(value) ? Math.max(60, Math.min(1800, value)) : 300;
}

function metaError(payload, status) {
  const source = payload?.error || {};
  const error = new Error(clean(source.message, 800) || `Meta respondió HTTP ${status}`);
  error.statusCode = status === 401 || status === 403 ? 502 : status === 429 ? 503 : 502;
  error.metaCode = Number(source.code) || null;
  error.metaSubcode = Number(source.error_subcode) || null;
  error.retryable = status === 429 || status >= 500 || RETRYABLE_CODES.has(error.metaCode);
  error.details = {
    provider: "meta_marketing",
    category: error.metaCode === 190 ? "TOKEN_EXPIRED_OR_INVALID"
      : [10, 200, 294].includes(error.metaCode) ? "INSUFFICIENT_PERMISSION"
      : error.retryable ? "RATE_LIMIT_OR_TEMPORARY" : "META_REQUEST_FAILED",
    metaCode: error.metaCode,
    metaSubcode: error.metaSubcode,
    retryable: error.retryable,
  };
  return error;
}

async function graphPage(path, params, settings, attempt = 0) {
  const url = new URL(`https://graph.facebook.com/${settings.apiVersion}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${settings.accessToken}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      const error = metaError(payload, response.status);
      if (error.retryable && attempt < 2) {
        const retryAfter = Math.min(2000, Math.max(250, Number(response.headers.get("retry-after") || 0) * 1000 || 500 * (attempt + 1)));
        await wait(retryAfter);
        return graphPage(path, params, settings, attempt + 1);
      }
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Meta Marketing API superó el tiempo de espera");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function graphList(path, params, settings, maxItems = 10000) {
  const rows = [];
  let after = "";
  const seenCursors = new Set();
  do {
    const payload = await graphPage(path, { ...params, limit: 200, ...(after ? { after } : {}) }, settings);
    if (Array.isArray(payload.data)) rows.push(...payload.data);
    after = clean(payload?.paging?.cursors?.after, 1000);
    if (!payload?.paging?.next || seenCursors.has(after)) after = "";
    if (after) seenCursors.add(after);
  } while (after && rows.length < maxItems);
  return rows.slice(0, maxItems);
}

async function listAccounts(settings) {
  if (settings.accountIds.length) {
    return Promise.all(settings.accountIds.map(async (id) => {
      const row = await graphPage(`act_${id}`, { fields: "id,account_id,name,account_status,currency,timezone_name" }, settings);
      return row;
    }));
  }
  return graphList("me/adaccounts", { fields: "id,account_id,name,account_status,currency,timezone_name" }, settings, 200);
}

function mergeAds(account, campaigns, adsets, ads) {
  const campaignsById = new Map(campaigns.map((row) => [String(row.id), row]));
  const adsetsById = new Map(adsets.map((row) => [String(row.id), row]));
  return ads.map((ad) => {
    const adset = adsetsById.get(String(ad.adset_id)) || {};
    const campaignId = String(ad.campaign_id || adset.campaign_id || "");
    const campaign = campaignsById.get(campaignId) || {};
    return {
      id: String(ad.id),
      name: ad.name || null,
      status: ad.status || null,
      effectiveStatus: ad.effective_status || null,
      accountId: String(account.account_id || account.id || "").replace(/^act_/, ""),
      adsetId: ad.adset_id ? String(ad.adset_id) : null,
      adsetName: adset.name || null,
      campaignId: campaignId || null,
      campaignName: campaign.name || null,
      campaignStatus: campaign.status || null,
      campaignEffectiveStatus: campaign.effective_status || null,
    };
  });
}

export async function getMetaMarketingSnapshot({ since, until, accountId = "all", force = false } = {}) {
  const settings = config();
  if (settings.missing.length) {
    return { configured: false, missingEnvironment: settings.missing, accounts: [], campaigns: [], adsets: [], ads: [], insights: [], dailyInsights: [], fetchedAt: null, cacheHit: false };
  }
  const key = JSON.stringify({ since, until, accountId, accounts: settings.accountIds, version: settings.apiVersion });
  const cached = CACHE.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value, cacheHit: true };

  let accounts = await listAccounts(settings);
  if (accountId && accountId !== "all") accounts = accounts.filter((row) => String(row.account_id || row.id).replace(/^act_/, "") === String(accountId).replace(/^act_/, ""));
  const campaigns = [];
  const adsets = [];
  const ads = [];
  const insights = [];
  const dailyInsights = [];
  for (const account of accounts) {
    const id = String(account.account_id || account.id).replace(/^act_/, "");
    const [accountCampaigns, accountAdsets, accountAds, accountInsights, accountDailyInsights] = await Promise.all([
      graphList(`act_${id}/campaigns`, { fields: "id,name,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining,buying_type,objective" }, settings),
      graphList(`act_${id}/adsets`, { fields: "id,name,status,effective_status,campaign_id,start_time,end_time,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event" }, settings),
      graphList(`act_${id}/ads`, { fields: "id,name,status,effective_status,campaign_id,adset_id" }, settings),
      graphList(`act_${id}/insights`, {
        level: "ad",
        time_range: JSON.stringify({ since, until }),
        fields: "date_start,date_stop,account_id,account_name,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,unique_clicks,inline_link_clicks,ctr,cpc,cpm,frequency,actions",
      }, settings, 25000),
      graphList(`act_${id}/insights`, {
        level: "ad",
        time_increment: 1,
        time_range: JSON.stringify({ since, until }),
        fields: "date_start,date_stop,account_id,account_name,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,unique_clicks,inline_link_clicks,ctr,cpc,cpm,frequency,actions",
      }, settings, 25000),
    ]);
    campaigns.push(...accountCampaigns.map((row) => ({ ...row, accountId: id, accountCurrency: account.currency || null })));
    adsets.push(...accountAdsets.map((row) => ({ ...row, accountId: id, accountCurrency: account.currency || null })));
    ads.push(...mergeAds(account, accountCampaigns, accountAdsets, accountAds));
    insights.push(...accountInsights.map((row) => ({ ...row, account_currency: row.account_currency || account.currency || null })));
    dailyInsights.push(...accountDailyInsights.map((row) => ({ ...row, account_currency: row.account_currency || account.currency || null })));
  }
  const value = { configured: true, missingEnvironment: [], apiVersion: settings.apiVersion, accounts, campaigns, adsets, ads, insights, dailyInsights, fetchedAt: new Date().toISOString(), cacheHit: false, cacheTtlSeconds: cacheSeconds() };
  CACHE.set(key, { expiresAt: Date.now() + cacheSeconds() * 1000, value });
  while (CACHE.size > 50) CACHE.delete(CACHE.keys().next().value);
  return value;
}

export const metaMarketingInternals = { config, graphList, mergeAds, metaError };
