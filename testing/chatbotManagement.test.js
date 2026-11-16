import test from "node:test";
import assert from "node:assert/strict";
import { createChatbotManagementService } from "../lib/chatbotManagement.js";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function fieldValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  return value ?? null;
}

class FakeSnapshot {
  constructor(reference, data) {
    this.ref = reference;
    this.id = reference.id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return clone(this._data);
  }
}

class FakeDocumentReference {
  constructor(database, path) {
    this.database = database;
    this.path = path;
    this.id = path.split("/").at(-1);
  }

  collection(name) {
    return new FakeCollectionReference(this.database, `${this.path}/${name}`);
  }

  async get() {
    return new FakeSnapshot(this, this.database.documents.get(this.path));
  }
}

class FakeQuery {
  constructor(database, path, order = null, maximum = null) {
    this.database = database;
    this.path = path;
    this.order = order;
    this.maximum = maximum;
  }

  orderBy(field, direction = "asc") {
    return new FakeQuery(this.database, this.path, { field, direction }, this.maximum);
  }

  limit(maximum) {
    return new FakeQuery(this.database, this.path, this.order, maximum);
  }

  async get() {
    const prefix = `${this.path}/`;
    let rows = [...this.database.documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({
        reference: new FakeDocumentReference(this.database, path),
        data: clone(data),
      }));
    if (this.order) {
      const multiplier = this.order.direction === "desc" ? -1 : 1;
      rows.sort((left, right) => {
        const a = fieldValue(left.data[this.order.field]);
        const b = fieldValue(right.data[this.order.field]);
        return a < b ? -multiplier : a > b ? multiplier : 0;
      });
    }
    if (this.maximum !== null) rows = rows.slice(0, this.maximum);
    const docs = rows.map((row) => new FakeSnapshot(row.reference, row.data));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollectionReference extends FakeQuery {
  doc(id = null) {
    const documentId = id || `auto_${++this.database.sequence}`;
    return new FakeDocumentReference(this.database, `${this.path}/${documentId}`);
  }
}

class FakeTransaction {
  constructor(database) {
    this.database = database;
    this.operations = [];
  }

  async get(reference) {
    return reference.get();
  }

  create(reference, data) {
    this.operations.push({ type: "create", reference, data: clone(data) });
  }

  update(reference, patch) {
    this.operations.push({ type: "update", reference, data: clone(patch) });
  }

  commit() {
    const next = new Map([...this.database.documents.entries()].map(([path, data]) => [path, clone(data)]));
    for (const operation of this.operations) {
      const path = operation.reference.path;
      if (operation.type === "create") {
        if (next.has(path)) throw Object.assign(new Error("already exists"), { code: 6 });
        next.set(path, clone(operation.data));
      } else {
        if (!next.has(path)) throw Object.assign(new Error("not found"), { code: 5 });
        next.set(path, { ...next.get(path), ...clone(operation.data) });
      }
    }
    this.database.documents = next;
  }
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
    this.sequence = 0;
  }

  collection(path) {
    return new FakeCollectionReference(this, path);
  }

  async runTransaction(callback) {
    const transaction = new FakeTransaction(this);
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }
}

const admin = { uid: "admin-1", email: "admin@example.com", isAdmin: true };
const seller = { uid: "seller-1", email: "seller@example.com", isAdmin: false };

function flow(name = "Consulta comercial", prompt = "¿Qué necesitás?") {
  return {
    name,
    welcomeMessage: "Hola",
    maxAttempts: 3,
    startQuestionId: "consulta",
    transfer: { onComplete: true, humanKeywords: ["vendedor"], message: "Te derivamos" },
    questions: [
      {
        id: "consulta",
        key: "consulta",
        prompt,
        type: "text",
        required: true,
        validation: { minLength: 2, maxLength: 200 },
      },
    ],
  };
}

function setup() {
  const database = new FakeFirestore();
  let clock = 0;
  const service = createChatbotManagementService({
    database,
    fieldValue: { serverTimestamp: () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++)) },
  });
  return { database, service };
}

test("solo administradores pueden leer o persistir flujos", async () => {
  const { service } = setup();
  await assert.rejects(service.listFlows(seller), (error) => error?.statusCode === 403);
  await assert.rejects(
    service.createFlow(seller, { flow: flow(), businessPhoneId: "12345678" }),
    (error) => error?.statusCode === 403
  );
});

test("crea, lista y obtiene un borrador siempre deshabilitado para runtime", async () => {
  const { service } = setup();
  const created = await service.createFlow(admin, {
    flow: flow(),
    businessPhoneId: "12345678",
  });
  assert.equal(created.flow.revision, 1);
  assert.equal(created.flow.status, "draft");
  assert.equal(created.flow.runtimeEnabled, false);
  assert.equal(created.flow.draft.id, created.flow.id);

  const listed = await service.listFlows(admin);
  assert.equal(listed.flows.length, 1);
  assert.equal(listed.flows[0].id, created.flow.id);
  assert.equal(Object.hasOwn(listed.flows[0], "draft"), false);

  const loaded = await service.getFlow(admin, { flowId: created.flow.id });
  assert.equal(loaded.flow.draft.questions[0].prompt, "¿Qué necesitás?");
});

test("edita con revisión optimista y rechaza una escritura concurrente obsoleta", async () => {
  const { service } = setup();
  const created = await service.createFlow(admin, { flow: flow() });
  const updated = await service.updateFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: 1,
    flow: flow("Consulta actualizada", "Contanos tu consulta"),
    businessPhoneId: "87654321",
  });
  assert.equal(updated.flow.revision, 2);
  assert.equal(updated.flow.name, "Consulta actualizada");
  assert.equal(updated.flow.businessPhoneId, "87654321");
  await assert.rejects(
    service.updateFlow(admin, {
      flowId: created.flow.id,
      expectedRevision: 1,
      flow: flow("Escritura vieja"),
    }),
    (error) => error?.statusCode === 409 && error?.details?.currentRevision === 2
  );
});

test("rechaza persistir un flujo inválido y devuelve errores utilizables por el editor", async () => {
  const { service } = setup();
  await assert.rejects(
    service.createFlow(admin, { flow: { name: "Inválido", questions: [] } }),
    (error) =>
      error?.statusCode === 422 &&
      Array.isArray(error?.details?.errors) &&
      error.details.errors.some((item) => item.path === "questions")
  );
});

test("publica snapshots inmutables sin habilitar ejecución y conserva historial", async () => {
  const { service } = setup();
  const created = await service.createFlow(admin, { flow: flow("Versión uno") });
  const firstPublication = await service.publishFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: 1,
  });
  assert.equal(firstPublication.version, 1);
  assert.equal(firstPublication.flow.runtimeEnabled, false);
  assert.equal(firstPublication.flow.hasUnpublishedChanges, false);

  const updated = await service.updateFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: 2,
    flow: flow("Versión dos", "Segunda pregunta"),
  });
  const secondPublication = await service.publishFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: updated.flow.revision,
  });
  assert.equal(secondPublication.version, 2);
  assert.equal(secondPublication.flow.publishedVersion, 2);

  const history = await service.listVersions(admin, { flowId: created.flow.id });
  assert.deepEqual(history.versions.map((item) => item.version), [2, 1]);
  assert.equal(history.versions.every((item) => item.runtimeEnabled === false), true);
  assert.equal(history.versions[0].flow.name, "Versión dos");
  assert.equal(history.versions[1].flow.name, "Versión uno");
});

test("restaurar una versión crea un nuevo borrador sin alterar snapshots publicados", async () => {
  const { service } = setup();
  const created = await service.createFlow(admin, { flow: flow("Original") });
  const publishedOne = await service.publishFlow(admin, { flowId: created.flow.id, expectedRevision: 1 });
  const updated = await service.updateFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: publishedOne.flow.revision,
    flow: flow("Nueva"),
  });
  const publishedTwo = await service.publishFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: updated.flow.revision,
  });
  const restored = await service.restoreVersion(admin, {
    flowId: created.flow.id,
    expectedRevision: publishedTwo.flow.revision,
    version: 1,
  });
  assert.equal(restored.flow.draft.name, "Original");
  assert.equal(restored.flow.publishedVersion, 2);
  assert.equal(restored.flow.hasUnpublishedChanges, true);
  assert.equal(restored.flow.runtimeEnabled, false);

  const history = await service.listVersions(admin, { flowId: created.flow.id });
  assert.deepEqual(history.versions.map((item) => item.version), [2, 1]);
});

test("duplica como borrador independiente y elimina de forma lógica", async () => {
  const { service } = setup();
  const created = await service.createFlow(admin, { flow: flow("Base") });
  const duplicated = await service.duplicateFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: 1,
  });
  assert.notEqual(duplicated.flow.id, created.flow.id);
  assert.equal(duplicated.flow.name, "Base (copia)");
  assert.equal(duplicated.flow.status, "draft");
  assert.equal(duplicated.flow.runtimeEnabled, false);

  const removed = await service.deleteFlow(admin, {
    flowId: created.flow.id,
    expectedRevision: 1,
  });
  assert.equal(removed.deleted, true);
  const visible = await service.listFlows(admin);
  assert.deepEqual(visible.flows.map((item) => item.id), [duplicated.flow.id]);
  const withDeleted = await service.listFlows(admin, { includeDeleted: true });
  assert.equal(withDeleted.flows.length, 2);
  await assert.rejects(
    service.getFlow(admin, { flowId: created.flow.id }),
    (error) => error?.statusCode === 410
  );
});
