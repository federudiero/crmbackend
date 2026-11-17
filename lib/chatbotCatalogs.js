import { db, FieldValue } from "./firebaseAdmin.js";

const COLLECTION = "chatbotCatalogs";
const EVENTS = "chatbotCatalogEvents";
const CONFIGS = "chatbotRuntimeConfigs";

export const CHATBOT_CATALOG_ACTIONS = Object.freeze([
  "chatbot_catalogs_list", "chatbot_catalog_create", "chatbot_catalog_update",
  "chatbot_catalog_assign", "chatbot_catalog_quote_preview",
]);
const ACTION_SET = new Set(CHATBOT_CATALOG_ACTIONS);

function fail(message, statusCode = 400, details) {
  const error = Object.assign(new Error(message), { statusCode });
  if (details) error.details = details;
  throw error;
}
function adminOnly(actor) {
  if (!actor?.isAdmin || !actor?.uid || !actor?.email) fail("Acceso administrativo requerido", 403);
}
function str(value, max = 160) { return String(value ?? "").trim().slice(0, max); }
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("Revisión inválida");
  return value;
}
function phoneId(value) {
  const valueString = str(value, 25);
  if (!/^\d{8,25}$/.test(valueString)) fail("Phone Number ID inválido");
  return valueString;
}
function normalizeProduct(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail(`Producto ${index + 1} inválido`);
  const sku = str(row.sku, 80);
  const name = str(row.name, 180);
  const presentation = str(row.presentation, 100);
  if (row.price === "" || row.price === null || row.price === undefined) fail(`Falta el precio del producto ${index + 1}`);
  const price = Number(row.price);
  if (!sku || !/^[a-zA-Z0-9._-]{1,80}$/.test(sku)) fail(`SKU inválido en producto ${index + 1}`);
  if (!name) fail(`Falta el nombre del producto ${index + 1}`);
  if (!Number.isSafeInteger(price) || price < 0 || price > 999_999_999) fail(`Precio inválido en producto ${index + 1}`);
  return { sku, name, presentation, price, active: row.active !== false };
}
function normalizeCatalog(payload = {}) {
  const name = str(payload.name, 160);
  if (!name) fail("Falta el nombre del catálogo");
  const region = str(payload.region, 100);
  const priceType = str(payload.priceType, 100) || "minorista";
  const currency = str(payload.currency, 3).toUpperCase() || "ARS";
  if (currency !== "ARS") fail("Esta versión del catálogo admite solamente ARS");
  if (!Array.isArray(payload.products) || payload.products.length > 150) fail("Se admiten hasta 150 productos por catálogo");
  const products = payload.products.map(normalizeProduct);
  const skus = new Set(products.map((item) => item.sku.toLowerCase()));
  if (skus.size !== products.length) fail("El catálogo tiene SKU repetidos");
  return { name, region, priceType, currency, products, active: payload.active !== false };
}
function publicCatalog(id, data = {}) {
  return {
    id, name: data.name, region: data.region || "", priceType: data.priceType || "minorista",
    currency: data.currency || "ARS", products: data.products || [], active: data.active !== false,
    revision: Number(data.revision) || 0, updatedAt: data.updatedAt || null,
  };
}
export function createChatbotCatalogService({ database = db, fieldValue = FieldValue } = {}) {
  const stamp = () => fieldValue.serverTimestamp();
  async function list(actor) {
    adminOnly(actor);
    const snapshot = await database.collection(COLLECTION).get();
    return { catalogs: snapshot.docs.map((doc) => publicCatalog(doc.id, doc.data())).sort((a, b) => a.name.localeCompare(b.name, "es")) };
  }
  async function create(actor, payload) {
    adminOnly(actor);
    const catalog = normalizeCatalog(payload);
    const ref = database.collection(COLLECTION).doc();
    const now = stamp();
    const doc = { ...catalog, revision: 1, createdAt: now, updatedAt: now, createdByUid: actor.uid, updatedByUid: actor.uid };
    await ref.create(doc);
    return { catalog: publicCatalog(ref.id, doc) };
  }
  async function update(actor, payload) {
    adminOnly(actor);
    const id = str(payload.catalogId, 160);
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) fail("ID de catálogo inválido");
    const expected = revision(payload.expectedRevision);
    const catalog = normalizeCatalog(payload);
    const ref = database.collection(COLLECTION).doc(id);
    const eventRef = database.collection(EVENTS).doc();
    let result;
    await database.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) fail("Catálogo inexistente", 404);
      const currentRevision = Number(snapshot.get("revision")) || 0;
      if (currentRevision !== expected) fail("El catálogo fue modificado en otra sesión", 409, { currentRevision });
      const now = stamp();
      const next = { ...catalog, revision: currentRevision + 1, updatedAt: now, updatedByUid: actor.uid };
      tx.set(ref, next, { merge: true });
      tx.create(eventRef, { catalogId: id, action: "updated", actorUid: actor.uid, revision: next.revision, createdAt: now });
      result = publicCatalog(id, next);
    });
    return { catalog: result };
  }
  async function assign(actor, payload) {
    adminOnly(actor);
    const id = phoneId(payload.phoneId);
    const catalogId = str(payload.catalogId, 160);
    const expected = revision(payload.expectedRevision);
    if (catalogId && !/^[a-zA-Z0-9_-]{1,160}$/.test(catalogId)) fail("ID de catálogo inválido");
    const waba = await database.collection("wabaNumbers").get();
    const exists = waba.docs.some((doc) => {
      const row = doc.data() || {};
      return row.active !== false && [row.waPhoneId, row.phoneId, row.phoneNumberId, row.businessPhoneId, doc.id].some((item) => str(item, 25) === id);
    });
    if (!exists) fail("Número empresarial no registrado o inactivo", 404);
    const catalogRef = catalogId ? database.collection(COLLECTION).doc(catalogId) : null;
    const configRef = database.collection(CONFIGS).doc(id);
    const eventRef = database.collection(EVENTS).doc();
    let result;
    await database.runTransaction(async (tx) => {
      const [configSnap, catalogSnap] = await Promise.all([tx.get(configRef), catalogRef ? tx.get(catalogRef) : Promise.resolve(null)]);
      if (catalogId && (!catalogSnap?.exists || catalogSnap.get("active") === false)) fail("El catálogo no existe o está inactivo", 400);
      const previous = configSnap.exists ? configSnap.data() || {} : {};
      const currentRevision = Number(previous.revision) || 0;
      if (currentRevision !== expected) fail("La configuración cambió en otra sesión", 409, { currentRevision });
      if (previous.enabled === true || previous.requestedEnabled === true) fail("Desactivá primero el chatbot antes de cambiar su catálogo", 409);
      const next = {
        catalogId: catalogId || null, revision: currentRevision + 1,
        requestedEnabled: false, enabled: false, updatedAt: stamp(), updatedByUid: actor.uid,
      };
      tx.set(configRef, next, { merge: true });
      tx.create(eventRef, { phoneId: id, catalogId: catalogId || null, action: "assigned", actorUid: actor.uid, revision: next.revision, createdAt: stamp() });
      result = { phoneId: id, catalogId: next.catalogId, revision: next.revision };
    });
    return { assignment: result };
  }
  // Cotización estimativa, de solo lectura, basada exclusivamente en la lista asignada al Phone Number ID.
  // No reserva stock, no confirma precios finales ni genera pedidos.
  async function quotePreview(actor, payload = {}) {
    adminOnly(actor);
    const id = phoneId(payload.phoneId);
    const configSnapshot = await database.collection(CONFIGS).doc(id).get();
    const catalogId = str(configSnapshot.exists ? configSnapshot.get("catalogId") : "", 160);
    if (!catalogId) fail("Este número todavía no tiene un catálogo asignado", 409);
    if (payload.expectedCatalogId !== undefined && str(payload.expectedCatalogId, 160) !== catalogId) {
      fail("Cambió el catálogo asignado al número. Volvé a cargar antes de presupuestar", 409);
    }
    const catalogSnapshot = await database.collection(COLLECTION).doc(catalogId).get();
    if (!catalogSnapshot.exists || catalogSnapshot.get("active") !== true) {
      fail("El catálogo asignado no está activo o ya no existe", 409);
    }
    const catalog = catalogSnapshot.data() || {};
    const expectedCatalogRevision = payload.expectedCatalogRevision;
    if (expectedCatalogRevision !== undefined && expectedCatalogRevision !== null &&
        revision(expectedCatalogRevision) !== Number(catalog.revision)) {
      fail("El catálogo fue actualizado. Volvé a cargarlo antes de presupuestar", 409, { currentRevision: catalog.revision });
    }
    if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 30) {
      fail("La cotización requiere entre 1 y 30 líneas de producto", 422);
    }
    const products = new Map((catalog.products || []).filter((product) => product.active !== false)
      .map((product) => [product.sku, product]));
    const seen = new Set();
    let subtotal = 0;
    const items = payload.items.map((row, index) => {
      const sku = str(row?.sku, 80);
      const quantity = Number(row?.quantity);
      if (!sku || seen.has(sku)) fail(`SKU vacío o repetido en línea ${index + 1}`, 422);
      seen.add(sku);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
        fail(`Cantidad inválida en línea ${index + 1}`, 422);
      }
      const product = products.get(sku);
      if (!product) fail(`El producto ${sku} no está disponible en este catálogo`, 422);
      const unitPrice = Number(product.price);
      if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) fail(`Precio no disponible para ${sku}`, 422);
      const lineTotal = unitPrice * quantity;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
        fail("El importe excede el máximo permitido", 422);
      }
      subtotal += lineTotal;
      return { sku, name: product.name, presentation: product.presentation || "", quantity, unitPrice, lineTotal };
    });
    return {
      quote: {
        type: "catalog_estimate_only",
        phoneId: id, catalogId, catalogRevision: Number(catalog.revision) || 0,
        catalogName: catalog.name, region: catalog.region || "", priceType: catalog.priceType || "",
        currency: catalog.currency || "ARS", items, subtotal,
        shippingVerified: false, availabilityVerified: false, finalTotalVerified: false,
        orderCreated: false, customerConfirmed: false,
        warning: "Estimación de catálogo. No incluye envío ni confirma disponibilidad o condiciones finales.",
      },
    };
  }

  async function handleAction(actor, action, payload) {
    if (action === "chatbot_catalogs_list") return list(actor);
    if (action === "chatbot_catalog_create") return create(actor, payload);
    if (action === "chatbot_catalog_update") return update(actor, payload);
    if (action === "chatbot_catalog_assign") return assign(actor, payload);
    if (action === "chatbot_catalog_quote_preview") return quotePreview(actor, payload);
    fail("Acción de catálogo inválida");
  }
  return Object.freeze({ list, create, update, assign, quotePreview, handleAction });
}
export const chatbotCatalogs = createChatbotCatalogService();
export function isChatbotCatalogAction(action) { return ACTION_SET.has(String(action || "")); }
