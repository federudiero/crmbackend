const GRAPH_HOST = "https://graph.facebook.com";
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function fail(code, message, retryable = false) {
  return { ok: false, code, message, retryable };
}

function tokenForPhone(tokensJson, phoneId) {
  try {
    const parsed = JSON.parse(tokensJson || "{}");
    const token = clean(parsed?.[phoneId], 4096);
    return token || null;
  } catch {
    return null;
  }
}

export function buildChatbotGraphPayload(intent, recipient) {
  const to = clean(recipient, 30).replace(/\D+/g, "");
  if (!to) throw new Error("Destinatario inválido");
  const body = clean(intent?.body, 1000);
  if (!body) throw new Error("Mensaje vacío");

  if (intent?.type === "buttons") {
    const options = Array.isArray(intent.options) ? intent.options : [];
    if (!options.length || options.length > 3) throw new Error("Los botones de WhatsApp requieren entre 1 y 3 opciones");
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: options.map((option) => {
            const title = clean(option.label || option.value, 80);
            if (!title || title.length > 20) throw new Error("La etiqueta de un botón debe tener hasta 20 caracteres");
            return { type: "reply", reply: { id: clean(option.id || option.value, 256), title } };
          }),
        },
      },
    };
  }

  if (intent?.type === "list") {
    const options = Array.isArray(intent.options) ? intent.options : [];
    if (!options.length || options.length > 10) throw new Error("La lista de WhatsApp requiere entre 1 y 10 opciones");
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: "Ver opciones",
          sections: [{
            title: "Opciones",
            rows: options.map((option) => {
              const title = clean(option.label || option.value, 80);
              if (!title || title.length > 24) throw new Error("La etiqueta de una lista debe tener hasta 24 caracteres");
              return { id: clean(option.id || option.value, 200), title };
            }),
          }],
        },
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
}

export function createChatbotSender({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  async function send({ phoneId, recipient, intent, lastCustomerMessageAtMs }) {
    if (env.CHATBOT_RUNTIME_ENABLED !== "true" || env.CHATBOT_SEND_ENABLED !== "true") {
      return fail("SEND_DISABLED", "El envío del chatbot está deshabilitado");
    }
    const allowed = new Set(clean(env.CHATBOT_ALLOWED_PHONE_IDS, 2000).split(",").map((item) => item.trim()).filter(Boolean));
    if (!allowed.has(String(phoneId || ""))) return fail("PHONE_NOT_ALLOWED", "Número empresarial no autorizado");
    const inboundAt = Number(lastCustomerMessageAtMs) || 0;
    if (!inboundAt || now() - inboundAt > SESSION_WINDOW_MS || inboundAt > now() + 60_000) {
      return fail("WINDOW_CLOSED", "La ventana de atención de 24 horas no está abierta");
    }
    const version = clean(env.META_GRAPH_API_VERSION, 20);
    if (!/^v\d+\.\d+$/.test(version)) return fail("GRAPH_VERSION_MISSING", "Falta una versión válida de Meta Graph API");
    const token = tokenForPhone(env.CHATBOT_META_TOKENS_JSON, String(phoneId || ""));
    if (!token) return fail("TOKEN_MISSING", "No hay token backend para el número autorizado");
    if (typeof fetchImpl !== "function") return fail("FETCH_UNAVAILABLE", "No hay cliente HTTP disponible", true);

    let payload;
    try {
      payload = buildChatbotGraphPayload(intent, recipient);
    } catch (error) {
      return fail("INVALID_INTENT", error?.message || "Mensaje inválido");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(`${GRAPH_HOST}/${version}/${encodeURIComponent(phoneId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        return fail("META_SEND_ERROR", `Meta respondió HTTP ${response.status}`, retryable);
      }
      return { ok: true, messageId: clean(responseBody?.messages?.[0]?.id, 256) || null };
    } catch (error) {
      return fail(error?.name === "AbortError" ? "SEND_TIMEOUT" : "SEND_NETWORK_ERROR", error?.message || "Error de red", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({ send });
}

export const chatbotSenderInternals = Object.freeze({ SESSION_WINDOW_MS, tokenForPhone });
