// Punto de entrada para las rutas administrativas y de mensajería secundarias.
// Los handlers mantienen sus implementaciones originales en handlers/.
// Las rutas públicas se preservan mediante las rewrites de vercel.json.
const handlers = Object.freeze({
  "bulk-optin": () => import("../handlers/bulk-optin.js"),
  "check-template-eligibility": () => import("../handlers/check-template-eligibility.js"),
  "crmManagement": () => import("../handlers/crmManagement.js"),
  "debugEnv": () => import("../handlers/debugEnv.js"),
  "handleExpiredMedia": () => import("../handlers/handleExpiredMedia.js"),
  "inventory": () => import("../handlers/inventory.js"),
  "notifyInbound": () => import("../handlers/notifyInbound.js"),
  "purgeConversations": () => import("../handlers/purgeConversations.js"),
  "send-template": () => import("../handlers/send-template.js"),
  "sendMessage": () => import("../handlers/sendMessage.js"),
  "sender": () => import("../handlers/sender.js"),
  "templates": () => import("../handlers/templates.js"),
 });

export default async function handler(req, res) {
  const route = req.query?.__crmInternalRoute;
  if (["sendMessage", "send-template", "bulk-optin", "templates"].includes(route)) {
    return res.status(410).json({ ok: false, error: "CRM en modo estadísticas: envíos por API deshabilitados" });
  }
  const load = typeof route === "string" && Object.prototype.hasOwnProperty.call(handlers, route)
    ? handlers[route]
    : null;
  if (!load) return res.status(404).json({ ok: false, error: "route_not_found" });
  try {
    const mod = await load();
    return await mod.default(req, res);
  } catch (error) {
    console.error("[apiRouter]", route, error);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: "internal_error" });
  }
}
