/**
 * Cotización estimativa por catálogo asignado al número. No confirma stock ni envío.
 * Compatibilidad con flujos legacy de una sola línea y nuevos flujos multi-línea.
 */
function linesFromAnswers(config, answers) {
  if (Array.isArray(config.items) && config.items.length) {
    return config.items.map(({ skuAnswerKeys = [], skuAnswerKey, quantityAnswerKey }) => {
      const keys = skuAnswerKeys.length ? skuAnswerKeys : [skuAnswerKey];
      const candidates = keys.map((key) => answers?.[key]?.value).filter((value) => value !== undefined && value !== null);
      const quantity = answers?.[quantityAnswerKey]?.value;
      if (!candidates.length && quantity === undefined) return null;
      return candidates.length === 1 ? { sku: candidates[0], quantity } : { invalid: true };
    }).filter(Boolean);
  }
  const keys = Array.isArray(config.skuAnswerKeys) && config.skuAnswerKeys.length ? config.skuAnswerKeys : [config.skuAnswerKey];
  const candidates = keys.map((key) => answers?.[key]?.value).filter((value) => value !== undefined && value !== null);
  return candidates.length === 1 ? [{ sku: candidates[0], quantity: answers?.[config.quantityAnswerKey]?.value }] : [];
}

export function buildChatbotCatalogEstimate(flow, answers, assigned) {
  const config = flow?.catalogQuote;
  if (config?.enabled !== true) return null;
  if (!assigned || assigned.active !== true || !assigned.id || !Number.isSafeInteger(assigned.revision) || assigned.revision < 1 || assigned.currency !== "ARS") return null;
  const selected = linesFromAnswers(config, answers);
  if (!selected.length || selected.length > 3) return null;
  const products = new Map((assigned.products || []).filter((row) => row.active !== false).map((row) => [row.sku, row]));
  const grouped = new Map();
  for (const { sku, quantity, invalid } of selected) {
    if (invalid || typeof sku !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(sku) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) return null;
    const product = products.get(sku);
    if (!product || !Number.isSafeInteger(product.price) || product.price <= 0) return null;
    const sumQuantity = (grouped.get(sku) || 0) + quantity;
    if (!Number.isSafeInteger(sumQuantity) || sumQuantity > 10000) return null;
    grouped.set(sku, sumQuantity);
  }
  let subtotal = 0;
  const items = [];
  for (const [sku, quantity] of grouped) {
    const product = products.get(sku);
    const lineTotal = product.price * quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) return null;
    subtotal += lineTotal;
    items.push({ sku, productName: product.name, presentation: product.presentation || "", quantity, unitPrice: product.price, lineTotal });
  }
  const single = items.length === 1 ? items[0] : null;
  return {
    type: "catalog_estimate_only", catalogId: assigned.id, catalogRevision: assigned.revision,
    currency: "ARS", items, subtotal,
    // Campos históricos para consumidores que esperan una sola línea.
    ...(single ? { sku: single.sku, productName: single.productName, presentation: single.presentation, quantity: single.quantity, unitPrice: single.unitPrice } : {}),
    shippingVerified: false, availabilityVerified: false, finalTotalVerified: false,
  };
}

export function sameChatbotCatalogEstimate(before, after) {
  if (!before || !after) return false;
  if (["catalogId", "catalogRevision", "currency", "subtotal"].some((key) => before[key] !== after[key])) return false;
  const itemLines = (quote) => Array.isArray(quote.items) ? quote.items : [{ sku: quote.sku, quantity: quote.quantity, unitPrice: quote.unitPrice, lineTotal: quote.subtotal }];
  const a = itemLines(before), b = itemLines(after);
  return a.length === b.length && a.every((row, index) =>
    ["sku", "quantity", "unitPrice", "lineTotal"].every((key) => row[key] === b[index]?.[key]));
}

export function chatbotEstimateText(quote) {
  if (!quote) return "";
  const format = (value) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value);
  const items = Array.isArray(quote.items) ? quote.items : [{ ...quote, lineTotal: quote.subtotal }];
  const lines = items.map((item) => `${item.quantity} × ${String(item.productName || "Producto").slice(0, 65)}${item.presentation ? ` (${String(item.presentation).slice(0, 24)})` : ""}: ${format(item.lineTotal)}`);
  return `\n\nPresupuesto estimado del catálogo:\n${lines.join("\n")}\nSubtotal: ${format(quote.subtotal)}\n\nNo incluye envío. Stock, condiciones y total final pendientes de verificación por el vendedor.`;
}
