import test from "node:test";
import assert from "node:assert/strict";
import { createChatbotOperationsService } from "../lib/chatbotOperations.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

class Snapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this.value = data; }
  data() { return clone(this.value); }
  get(field) { return clone(this.value?.[field]); }
}

class DocumentRef {
  constructor(database, path) { this.database = database; this.path = path; this.id = path.split("/").at(-1); }
  async get() { return new Snapshot(this, this.database.documents.get(this.path)); }
}

class CollectionRef {
  constructor(database, path) { this.database = database; this.path = path; }
  doc(id = `auto_${++this.database.sequence}`) { return new DocumentRef(this.database, `${this.path}/${id}`); }
  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.database.documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => new Snapshot(new DocumentRef(this.database, path), data));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class Transaction {
  constructor(database) { this.database = database; this.operations = []; }
  get(ref) { return ref.get(); }
  create(ref, data) { this.operations.push({ ref, data: clone(data), create: true, merge: false }); }
  set(ref, data, options = {}) { this.operations.push({ ref, data: clone(data), create: false, merge: options.merge === true }); }
  commit() {
    const next = new Map([...this.database.documents.entries()].map(([path, data]) => [path, clone(data)]));
    for (const operation of this.operations) {
      if (operation.create && next.has(operation.ref.path)) throw new Error("already exists");
      const previous = next.get(operation.ref.path) || {};
      next.set(operation.ref.path, operation.merge ? { ...previous, ...operation.data } : operation.data);
    }
    this.database.documents = next;
  }
}

class Firestore {
  constructor(entries = []) { this.documents = new Map(entries); this.sequence = 0; }
  collection(path) { return new CollectionRef(this, path); }
  async runTransaction(callback) { const transaction = new Transaction(this); const result = await callback(transaction); transaction.commit(); return result; }
}

const admin = { uid: "admin", email: "admin@example.com", isAdmin: true };
const seller = { uid: "seller", email: "seller@example.com", isAdmin: false };
const env = {
  CHATBOT_RUNTIME_ENABLED: "true",
  CHATBOT_SEND_ENABLED: "true",
  CHATBOT_ALLOWED_PHONE_IDS: "12345678",
  CHATBOT_META_TOKENS_JSON: JSON.stringify({ 12345678: "secret" }),
  META_GRAPH_API_VERSION: "v27.0",
  META_APP_SECRET: "secret",
  META_WA_VERIFY_TOKEN: "verify",
};

function setup({ verified = false } = {}) {
  const documents = [
    ["wabaNumbers/number", { waPhoneId: "12345678", phone: "+54 9 11 1111 1111", active: true, ownerUid: "seller", owner: "seller@example.com", alias: "Vendedor" }],
    ["chatbotFlows/flow", { name: "Piloto", status: "published", businessPhoneId: "12345678", publishedVersion: 2 }],
  ];
  if (verified) documents.push(["chatbotRuntimeConfigs/12345678", { revision: 1, connectionVerifiedAt: "2026-11-16T00:00:00.000Z", enabled: false }]);
  const database = new Firestore(documents);
  const reactivations = [];
  const runtimeStore = {
    async getSession() { return { phoneId: "12345678", revision: 3 }; },
    async reactivate(payload) { reactivations.push(payload); return { status: "BOT_PENDING", revision: payload.expectedRevision + 1 }; },
  };
  const service = createChatbotOperationsService({
    database,
    env,
    runtimeStore,
    fieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
  });
  return { database, service, reactivations };
}

function payload(expectedRevision = 0) {
  return {
    phoneId: "12345678",
    expectedRevision,
    flowId: "flow",
    version: 2,
    defaultSellerUid: "seller",
    defaultSellerEmail: "seller@example.com",
    maxMessagesPerSession: 15,
    maxMessagesPerMinute: 5,
    maxSendAttempts: 2,
    requestedEnabled: true,
  };
}

test("las operaciones del piloto rechazan vendedores", async () => {
  const { service } = setup();
  await assert.rejects(service.listConfigs(seller), (error) => error?.statusCode === 403);
  await assert.rejects(service.updateConfig(seller, payload()), (error) => error?.statusCode === 403);
  await assert.rejects(service.reactivate(seller, { conversationId: "c1", expectedRevision: 3 }), (error) => error?.statusCode === 403);
});

test("guardar una solicitud no activa el runtime sin verificación backend de Meta", async () => {
  const { database, service } = setup();
  const result = await service.updateConfig(admin, payload());
  assert.equal(result.config.requestedEnabled, true);
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.connectionStatus.checks.metaConnectionVerified, false);
  assert.equal(database.documents.get("chatbotRuntimeConfigs/12345678").enabled, false);
});

test("la configuración usa revisión optimista y conserva auditoría", async () => {
  const { database, service } = setup();
  await service.updateConfig(admin, payload());
  await service.updateConfig(admin, payload(1));
  await assert.rejects(service.updateConfig(admin, payload(1)), (error) => error?.statusCode === 409 && error?.details?.currentRevision === 2);
  const auditRows = [...database.documents.keys()].filter((path) => path.startsWith("chatbotRuntimeConfigEvents/"));
  assert.equal(auditRows.length, 2);
});

test("solo todos los controles backend habilitan efectivamente una configuración", async () => {
  const { service } = setup({ verified: true });
  const result = await service.updateConfig(admin, payload(1));
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.connectionStatus.ready, true);
});

test("la reactivación administrativa exige revisión y runtime efectivo", async () => {
  const { database, service, reactivations } = setup({ verified: true });
  await service.updateConfig(admin, payload(1));
  const result = await service.reactivate(admin, { conversationId: "c1", expectedRevision: 3 });
  assert.equal(result.session.status, "BOT_PENDING");
  assert.equal(reactivations.length, 1);
  database.documents.get("chatbotRuntimeConfigs/12345678").enabled = false;
  await assert.rejects(service.reactivate(admin, { conversationId: "c1", expectedRevision: 4 }), (error) => error?.statusCode === 409);
});
