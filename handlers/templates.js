// api/templates.js
// Devuelve plantillas aprobadas en es_AR (promo + remarketing)
function setCors(req, res) {
  const ALLOWED = (process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const ALLOWED_TEMPLATE_NAMES = new Set([
  "promo_hogarcril_combos",
  "reengage_free_text",
]);

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const WABA_ID =
      process.env.META_WABA_ID ||
      process.env.META_WA_BUSINESS_ID ||
      process.env.META_WABA_BUSINESS_ID;

    const TOKEN = process.env.META_WA_TOKEN;
    if (!WABA_ID || !TOKEN) {
      return res.status(500).json({ error: "Missing META_WA_TOKEN or WABA ID" });
    }

    let url = `https://graph.facebook.com/v23.0/${WABA_ID}/message_templates?limit=100`;
    const all = [];

    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const txt = await r.text();

      let data;
      try { data = JSON.parse(txt); }
      catch {
        return res.status(r.status || 500).json({ error: "Upstream not JSON", raw: txt?.slice(0, 200) });
      }

      if (!r.ok) return res.status(r.status).json({ error: data?.error || data });
      all.push(...(data?.data || []));
      url = data?.paging?.next || "";
    }

    const mapped = all.map((t) => {
      const body = (t?.components || []).find((c) => c.type === "BODY");
      const text = body?.text || "";
      const nums = [...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => parseInt(m[1], 10)))]
        .sort((a, b) => a - b);

      return {
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language || t?.language?.code,
        variables: nums.map((n) => ({ position: n })),
        components: t.components,
      };
    });

    // ✅ devolvemos las que te interesan (es_AR) y que estén aprobadas o activas
    const filtered = mapped.filter((t) => {
      const nameOk = ALLOWED_TEMPLATE_NAMES.has(String(t.name || "").trim());
      const langOk = String(t.language || "").toLowerCase() === "es_ar";
      const status = String(t.status || "").toUpperCase();
      const statusOk = status === "APPROVED" || status === "PAUSED" || status === "IN_APPEAL" || status === "PENDING" || status === "REINSTATED";
      // Nota: Meta suele usar APPROVED; dejamos otros por si UI muestra “activa/calidad pendiente”
      return nameOk && langOk && statusOk;
    });

    return res.status(200).json({ templates: filtered });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
