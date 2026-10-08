import { handleCrmAction } from "../lib/crmManagement.js";

function setCors(res) {
  const origin = String(res.req?.headers?.origin || "");
  const allowed = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "crm-management",
      version: 1,
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const data = await handleCrmAction(req);
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    console.error("[crmManagement]", error);
    return res.status(status).json({
      ok: false,
      error: error?.message || "Error interno de Gestión CRM",
    });
  }
}
