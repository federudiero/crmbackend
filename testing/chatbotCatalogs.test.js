import test from "node:test";
import assert from "node:assert/strict";
import { createChatbotCatalogService } from "../lib/chatbotCatalogs.js";

const copy = (v) => v === undefined ? undefined : structuredClone(v);
class Snap {
  constructor(ref, value) { this.id = ref.id; this.exists = value !== undefined; this.value = value; }
  data() { return copy(this.value); }
  get(field) { return copy(this.value?.[field]); }
}
class Doc {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split("/").at(-1); }
  async get() { return new Snap(this, this.db.docs.get(this.path)); }
  async create(value) { if (this.db.docs.has(this.path)) throw Error("exists"); this.db.docs.set(this.path, copy(value)); }
}
class Collection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id = `new_${++this.db.sequence}`) { return new Doc(this.db, `${this.path}/${id}`); }
  async get() { const prefix = `${this.path}/`; return { docs: [...this.db.docs.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map(([path, value]) => new Snap(new Doc(this.db, path), value)) }; }
}
class Tx {
  constructor(db) { this.db = db; this.writes = []; }
  get(ref) { return ref.get(); }
  set(ref, data, options) { this.writes.push({ path: ref.path, data: copy(data), merge: options?.merge }); }
  create(ref, data) { this.writes.push({ path: ref.path, data: copy(data), create: true }); }
  commit() {
    for (const w of this.writes) {
      if (w.create && this.db.docs.has(w.path)) throw Error("exists");
      const before = this.db.docs.get(w.path) || {};
      this.db.docs.set(w.path, w.merge ? { ...before, ...w.data } : w.data);
    }
  }
}
class FakeFirestore {
  constructor() { this.docs = new Map([["wabaNumbers/number", { waPhoneId: "12345678", active: true }]]); this.sequence = 0; }
  collection(name) { return new Collection(this, name); }
  async runTransaction(cb) { const tx = new Tx(this); const result = await cb(tx); tx.commit(); return result; }
}
const admin = { isAdmin: true, uid: "admin", email: "a@example.com" };
const seller = { isAdmin: false, uid: "seller", email: "s@example.com" };
const payload = { name: "Córdoba minorista", region: "Córdoba", priceType: "minorista", products: [{ sku: "LATEX-20", name: "Látex", presentation: "20 L", price: 28000 }] };
function setup() { const database = new FakeFirestore(); return { database, service: createChatbotCatalogService({ database, fieldValue: { serverTimestamp: () => "NOW" } }) }; }

test("Solo el administrador consulta, crea y asigna catálogos", async () => {
  const { service } = setup();
  await assert.rejects(service.list(seller), (e) => e.statusCode === 403);
  await assert.rejects(service.create(seller, payload), (e) => e.statusCode === 403);
  await assert.rejects(service.assign(seller, { phoneId: "12345678", expectedRevision: 0 }), (e) => e.statusCode === 403);
});

test("Catálogo CRUD sin precios negativos ni SKU duplicados", async () => {
  const { service } = setup();
  const created = await service.create(admin, payload);
  assert.equal(created.catalog.revision, 1);
  assert.equal((await service.list(admin)).catalogs.length, 1);
  await assert.rejects(service.create(admin, { ...payload, products: [{ sku: "x", name: "X", price: -1 }] }), /Precio inválido/);
  await assert.rejects(service.create(admin, { ...payload, products: [{ sku: "X", name: "X", price: 1 }, { sku: "x", name: "Y", price: 2 }] }), /SKU repetidos/);
  const edited = await service.update(admin, { ...payload, catalogId: created.catalog.id, expectedRevision: 1, products: [{ sku: "LATEX-20", name: "Látex", price: 30000 }] });
  assert.equal(edited.catalog.revision, 2);
  await assert.rejects(service.update(admin, { ...payload, catalogId: created.catalog.id, expectedRevision: 1 }), (e) => e.statusCode === 409);
});

test("Asignación no activa runtime y preserva configuración existente", async () => {
  const { database, service } = setup();
  const catalog = (await service.create(admin, payload)).catalog;
  database.docs.set("chatbotRuntimeConfigs/12345678", { revision: 4, flowId: "existing", enabled: false, requestedEnabled: false });
  const assigned = await service.assign(admin, { phoneId: "12345678", catalogId: catalog.id, expectedRevision: 4 });
  assert.equal(assigned.assignment.revision, 5);
  const config = database.docs.get("chatbotRuntimeConfigs/12345678");
  assert.equal(config.catalogId, catalog.id);
  assert.equal(config.flowId, "existing");
  assert.equal(config.enabled, false);
  assert.equal(config.requestedEnabled, false);
  await assert.rejects(service.assign(admin, { phoneId: "12345678", catalogId: "", expectedRevision: 4 }), (e) => e.statusCode === 409);
});

test("Asignación rechaza números inválidos, catálogos inactivos y bot encendido", async () => {
  const { database, service } = setup();
  const catalog = (await service.create(admin, { ...payload, active: false })).catalog;
  await assert.rejects(service.assign(admin, { phoneId: "99999999", catalogId: catalog.id, expectedRevision: 0 }), (e) => e.statusCode === 404);
  await assert.rejects(service.assign(admin, { phoneId: "12345678", catalogId: catalog.id, expectedRevision: 0 }), /inactivo/);
  database.docs.set("chatbotRuntimeConfigs/12345678", { revision: 1, enabled: true });
  await assert.rejects(service.assign(admin, { phoneId: "12345678", catalogId: "", expectedRevision: 1 }), (e) => e.statusCode === 409);
});

test("Vista previa calcula subtotal usando únicamente el catálogo asignado al número", async () => {
  const { service } = setup();
  const catalog = (await service.create(admin, payload)).catalog;
  await service.assign(admin, { phoneId: "12345678", catalogId: catalog.id, expectedRevision: 0 });
  const result = await service.quotePreview(admin, {
    phoneId: "12345678", expectedCatalogRevision: catalog.revision,
    items: [{ sku: "LATEX-20", quantity: 3 }],
  });
  assert.equal(result.quote.subtotal, 84000);
  assert.equal(result.quote.items[0].unitPrice, 28000);
  assert.equal(result.quote.finalTotalVerified, false);
  assert.equal(result.quote.availabilityVerified, false);
  assert.equal(result.quote.orderCreated, false);
});

test("Cotización exige permisos, asignación y SKU activo y valida cantidades", async () => {
  const { service } = setup();
  const catalog = (await service.create(admin, payload)).catalog;
  const request = { phoneId: "12345678", items: [{ sku: "LATEX-20", quantity: 1 }] };
  await assert.rejects(service.quotePreview(seller, request), (e) => e.statusCode === 403);
  await assert.rejects(service.quotePreview(admin, request), (e) => e.statusCode === 409);
  await service.assign(admin, { phoneId: "12345678", catalogId: catalog.id, expectedRevision: 0 });
  await assert.rejects(service.quotePreview(admin, { ...request, expectedCatalogRevision: 0 }), (e) => e.statusCode === 409);
  await assert.rejects(service.quotePreview(admin, { ...request, items: [{ sku: "NO-EXISTE", quantity: 1 }] }), (e) => e.statusCode === 422);
  await assert.rejects(service.quotePreview(admin, { ...request, items: [{ sku: "LATEX-20", quantity: 1.5 }] }), (e) => e.statusCode === 422);
  await assert.rejects(service.quotePreview(admin, { ...request, items: [{ sku: "LATEX-20", quantity: 1 }, { sku: "LATEX-20", quantity: 2 }] }), (e) => e.statusCode === 422);
});

test("Cotización refleja actualización de precio y bloquea revisiones obsoletas", async () => {
  const { service } = setup();
  const catalog = (await service.create(admin, payload)).catalog;
  await service.assign(admin, { phoneId: "12345678", catalogId: catalog.id, expectedRevision: 0 });
  await service.update(admin, { ...payload, catalogId: catalog.id, expectedRevision: 1,
    products: [{ sku: "LATEX-20", name: "Látex", presentation: "20 L", price: 35000 }] });
  await assert.rejects(service.quotePreview(admin, { phoneId: "12345678", expectedCatalogRevision: 1, items: [{ sku: "LATEX-20", quantity: 2 }] }), (e) => e.statusCode === 409);
  const latest = await service.quotePreview(admin, { phoneId: "12345678", expectedCatalogRevision: 2, items: [{ sku: "LATEX-20", quantity: 2 }] });
  assert.equal(latest.quote.subtotal, 70000);
});


test("Vista previa detecta cambio de asignación y rechaza precio cero", async () => {
  const { service } = setup();
  const old = (await service.create(admin, payload)).catalog;
  await service.assign(admin, { phoneId: "12345678", catalogId: old.id, expectedRevision: 0 });
  await assert.rejects(service.quotePreview(admin, { phoneId: "12345678", expectedCatalogId: "diferente", items: [{ sku: "LATEX-20", quantity: 1 }] }), (e) => e.statusCode === 409);
  await service.update(admin, { ...payload, catalogId: old.id, expectedRevision: 1, products: [{ sku: "LATEX-20", name: "Látex", price: 0 }] });
  await assert.rejects(service.quotePreview(admin, { phoneId: "12345678", items: [{ sku: "LATEX-20", quantity: 1 }] }), (e) => e.statusCode === 422);
});
