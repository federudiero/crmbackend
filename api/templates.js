// Devuelve SOLO la plantilla promo_hogarcril_combos (es_AR) si está APPROVED/MARKETING.
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const ORIGIN = process.env.ALLOWED_ORIGIN || "https://crmhogarcril.com";
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    const WABA_ID =
      process.env.META_WABA_ID ||
      process.env.META_WA_BUSINESS_ID ||
      process.env.META_WABA_BUSINESS_ID;

    const TOKEN = process.env.META_WA_TOKEN;
    if (!WABA_ID || !TOKEN) {
      return res.status(500).json({ error: "Missing META_WA_TOKEN or WABA ID" });
    }

    let url = `https://graph.facebook.com/v21.0/${WABA_ID}/message_templates?limit=100`;
    const all = [];
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); }
      catch { return res.status(r.status || 500).json({ error: "Upstream not JSON", raw: txt?.slice(0,200) }); }
      if (!r.ok) return res.status(r.status).json({ error: data?.error || data });
      all.push(...(data?.data || []));
      url = data?.paging?.next || "";
    }

    const mapped = all.map((t) => {
      const body = (t?.components || []).find((c) => c.type === "BODY");
      const text = body?.text || "";
      const nums = [...new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map(m => parseInt(m[1],10)))].sort((a,b)=>a-b);
      return {
        name: t.name,
        status: t.status,
        category: t.category,
        language: t.language || t?.language?.code,
        variables: nums.map(n => ({ position: n })),
        components: t.components
      };
    });

    const filtered = mapped.filter(t =>
      t.name === "promo_hogarcril_combos" &&
      (t.language === "es_AR" || t.language?.code === "es_AR") &&
      String(t.status).toUpperCase() === "APPROVED" &&
      String(t.category).toUpperCase() === "MARKETING"
    );

    return res.status(200).json({ templates: filtered });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
