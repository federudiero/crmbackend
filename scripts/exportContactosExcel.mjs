// scripts/exportContactosExcel.mjs
// Exporta Firestore contacts -> Excel sin modificar la base de datos.
// Uso desde la carpeta del backend:
//   npm i xlsx
//   node scripts/exportContactosExcel.mjs --service-account=serviceAccountKey.json
//
// Opciones:
//   --out=exports/contactos-crm.xlsx
//   --service-account=serviceAccountKey.json
//   --raw                 No unifica duplicados; exporta cada doc como fila principal.
//   --no-conversations    No busca datos complementarios en conversations.
//   --limit=100           Limita cantidad de docs leídos de contacts para prueba.
//   --pageSize=700        Tamaño de página de lectura, máximo 1000.
//
// Credenciales aceptadas, en este orden:
//   1) --service-account=RUTA_JSON
//   2) FIREBASE_SERVICE_ACCOUNT con el JSON completo
//   3) FIREBASE_SERVICE_ACCOUNT_BASE64 con el JSON en base64
//   4) GOOGLE_APPLICATION_CREDENTIALS apuntando a un JSON
//   5) ./serviceAccountKey.json, ./service-account.json o ./firebase-service-account.json
//
// Seguridad: solo lee contacts/conversations. No usa set/update/delete.

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import admin from "firebase-admin";

let XLSX;
try {
  XLSX = await import("xlsx");
} catch (error) {
  console.error("\nFalta instalar la dependencia local para generar Excel:");
  console.error("  npm i xlsx\n");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  return new Map(
    argv.slice(2).map((arg) => {
      if (!arg.startsWith("--")) return [arg, true];
      const [key, ...rest] = arg.slice(2).split("=");
      return [key, rest.length ? rest.join("=") : true];
    })
  );
}

const args = parseArgs(process.argv);

const OUT_FILE = String(args.get("out") || "exports/contactos-crm.xlsx");
const RAW_MODE = args.has("raw");
const INCLUDE_CONVERSATIONS = !args.has("no-conversations");
const LIMIT = Number.parseInt(String(args.get("limit") || "0"), 10) || 0;
const PAGE_SIZE = Math.min(
  Number.parseInt(String(args.get("pageSize") || "700"), 10) || 700,
  1000
);

function stripOuterQuotes(value) {
  const text = String(value ?? "").trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseDotenvLine(line) {
  const clean = line.trim();
  if (!clean || clean.startsWith("#")) return null;
  const index = clean.indexOf("=");
  if (index <= 0) return null;
  const key = clean.slice(0, index).trim();
  const rawValue = clean.slice(index + 1).trim();
  return [key, stripOuterQuotes(rawValue)];
}

function loadEnvFileIfExists(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const content = fsSync.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (!process.env[key]) process.env[key] = value;
  }
}

// Carga simple de .env sin agregar dotenv al proyecto.
loadEnvFileIfExists(path.join(backendRoot, ".env"));
loadEnvFileIfExists(path.join(backendRoot, ".env.local"));

function resolveMaybeRelative(inputPath) {
  const text = String(inputPath || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(backendRoot, text);
}

function normalizeServiceAccount(sa) {
  if (!sa || typeof sa !== "object") return sa;

  // En algunos .env private_key queda como "-----BEGIN...\\n...".
  if (typeof sa.private_key === "string") {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }

  return sa;
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return normalizeServiceAccount(JSON.parse(content));
}

function parseServiceAccountJson(raw, label) {
  const text = stripOuterQuotes(raw);
  if (!text) return null;

  try {
    return normalizeServiceAccount(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} contiene JSON inválido: ${error?.message || error}`);
  }
}

async function getServiceAccount() {
  const explicitPath = args.get("service-account") || args.get("serviceAccount");
  if (explicitPath && explicitPath !== true) {
    const filePath = resolveMaybeRelative(explicitPath);
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`No existe el archivo de credencial indicado: ${filePath}`);
    }
    return {
      source: `archivo indicado por --service-account (${filePath})`,
      json: await readJsonFile(filePath),
    };
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return {
      source: "variable FIREBASE_SERVICE_ACCOUNT",
      json: parseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT, "FIREBASE_SERVICE_ACCOUNT"),
    };
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
    return {
      source: "variable FIREBASE_SERVICE_ACCOUNT_BASE64",
      json: parseServiceAccountJson(decoded, "FIREBASE_SERVICE_ACCOUNT_BASE64"),
    };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const filePath = resolveMaybeRelative(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS apunta a un archivo inexistente: ${filePath}`);
    }
    return {
      source: `GOOGLE_APPLICATION_CREDENTIALS (${filePath})`,
      json: await readJsonFile(filePath),
    };
  }

  const defaultFiles = [
    "serviceAccountKey.json",
    "service-account.json",
    "firebase-service-account.json",
  ];

  for (const name of defaultFiles) {
    const filePath = path.join(backendRoot, name);
    if (fsSync.existsSync(filePath)) {
      return {
        source: `archivo local ${name}`,
        json: await readJsonFile(filePath),
      };
    }
  }

  return null;
}

async function initializeFirebaseAdmin() {
  if (admin.apps.length) return admin.firestore();

  const credential = await getServiceAccount();

  if (!credential?.json) {
    throw new Error(
      [
        "No encontré credenciales de Firebase Admin para ejecutar el exportador localmente.",
        "Solución recomendada:",
        "1) Firebase Console > Project settings > Service accounts > Generate new private key.",
        "2) Guardá el archivo como crmbackend-master/serviceAccountKey.json.",
        "3) Ejecutá: node scripts/exportContactosExcel.mjs --service-account=serviceAccountKey.json",
        "4) Agregá serviceAccountKey.json al .gitignore y no lo subas a GitHub.",
      ].join("\n")
    );
  }

  const projectId = credential.json.project_id || credential.json.projectId;
  if (!projectId) {
    throw new Error(`La credencial encontrada en ${credential.source} no tiene project_id.`);
  }

  admin.initializeApp({
    credential: admin.credential.cert(credential.json),
    projectId,
  });

  console.log(`Firebase Admin inicializado con ${credential.source}`);
  console.log(`Proyecto Firebase: ${projectId}`);

  return admin.firestore();
}

const db = await initializeFirebaseAdmin();
const FieldPath = admin.firestore.FieldPath;

function digits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function isBlank(value) {
  return value === undefined || value === null || value === "";
}

function timestampToIso(value) {
  if (!value) return "";
  if (typeof value?.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (typeof value === "string") return value;
  return "";
}

function cleanFirestoreValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value?.toDate === "function") return timestampToIso(value);
  if (value instanceof Date) return timestampToIso(value);
  if (Array.isArray(value)) return value.map(cleanFirestoreValue).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const clean = cleanFirestoreValue(val);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
}

function toExcelValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value?.toDate === "function") return timestampToIso(value);
  if (value instanceof Date) return timestampToIso(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item === undefined || item === null) return "";
        if (typeof item === "object") return JSON.stringify(cleanFirestoreValue(item));
        return String(item);
      })
      .filter(Boolean)
      .join(" | ");
  }
  if (typeof value === "object") return JSON.stringify(cleanFirestoreValue(value));
  return value;
}

function flattenObject(obj, prefix = "") {
  const out = {};
  const clean = cleanFirestoreValue(obj || {});
  for (const [key, value] of Object.entries(clean || {})) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, fullKey));
    } else {
      out[fullKey] = toExcelValue(value);
    }
  }
  return out;
}

function contactKey(docId, data = {}) {
  const phoneDigits = digits(data.phone || data.waId || data.clientPhone || data.contactId || "");
  if (phoneDigits) return phoneDigits;

  const id = String(docId || "");
  if (id.includes("__")) {
    const afterScope = id.split("__").pop();
    const scopedDigits = digits(afterScope);
    if (scopedDigits) return scopedDigits;
  }

  const idDigits = digits(id);
  return idDigits || id;
}

function mergePreferFilled(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (isBlank(target[key]) && !isBlank(value)) {
      target[key] = value;
    }
  }
  return target;
}

function newestIso(...values) {
  const dates = values.map(timestampToIso).filter(Boolean).sort();
  return dates.at(-1) || "";
}

async function fetchAllContacts() {
  const rows = [];
  let lastDoc = null;

  while (true) {
    let q = db.collection("contacts").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const docSnap of snap.docs) {
      rows.push({ id: docSnap.id, data: docSnap.data() || {} });
      if (LIMIT && rows.length >= LIMIT) return rows;
    }

    lastDoc = snap.docs.at(-1);
    if (snap.size < PAGE_SIZE) break;
  }

  return rows;
}

function candidateConversationIdsForGroup(group) {
  const ids = new Set();
  for (const doc of group.docs || []) {
    if (doc?.data?.conversationId) ids.add(String(doc.data.conversationId));
    if (doc?.id) ids.add(String(doc.id));
  }
  return [...ids].filter(Boolean);
}

async function fetchConversationsByIds(ids) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 10) {
    const part = unique.slice(i, i + 10);
    if (!part.length) continue;

    const snap = await db
      .collection("conversations")
      .where(FieldPath.documentId(), "in", part)
      .get();

    snap.forEach((docSnap) => {
      out.set(docSnap.id, { id: docSnap.id, data: docSnap.data() || {} });
    });
  }

  return out;
}

function buildGroups(contactDocs) {
  if (RAW_MODE) {
    return contactDocs.map((doc) => ({
      key: doc.id,
      merged: { ...doc.data },
      docs: [doc],
    }));
  }

  const groups = new Map();

  for (const doc of contactDocs) {
    const key = contactKey(doc.id, doc.data);
    if (!groups.has(key)) {
      groups.set(key, { key, merged: {}, docs: [] });
    }

    const group = groups.get(key);
    group.docs.push(doc);
    mergePreferFilled(group.merged, doc.data);

    const createdCandidates = group.docs
      .map((d) => timestampToIso(d.data?.createdAt))
      .filter(Boolean)
      .sort();
    if (createdCandidates.length) group.merged.createdAt = createdCandidates[0];

    const updated = newestIso(group.merged.updatedAt, doc.data?.updatedAt);
    if (updated) group.merged.updatedAt = updated;
  }

  return [...groups.values()];
}

function pickConversationForGroup(group, conversationsById) {
  const candidates = candidateConversationIdsForGroup(group)
    .map((id) => conversationsById.get(id))
    .filter(Boolean);

  if (!candidates.length) return null;

  return candidates.sort((a, b) => {
    const aTime = timestampToIso(a.data?.lastMessageAt || a.data?.updatedAt || a.data?.createdAt);
    const bTime = timestampToIso(b.data?.lastMessageAt || b.data?.updatedAt || b.data?.createdAt);
    return String(bTime).localeCompare(String(aTime));
  })[0];
}

function buildUnifiedRow(group, conversation) {
  const contact = group.merged || {};
  const conversationData = conversation?.data || {};
  const contactDocIds = group.docs.map((d) => d.id);

  const base = {
    contactoKey: group.key,
    telefono: contact.phone || conversationData.clientPhone || conversationData.contactId || "",
    waId: contact.waId || digits(contact.phone || conversationData.clientPhone || conversationData.contactId || ""),
    nombre:
      contact.name ||
      contact.displayName ||
      contact.profileName ||
      conversationData.contactName ||
      conversationData.displayName ||
      conversationData.profileName ||
      "",
    email: contact.email || "",
    notas: contact.notes || "",
    optIn: contact.optIn === true ? "SI" : contact.optIn === false ? "NO" : "",
    creado: toExcelValue(contact.createdAt || conversationData.createdAt || ""),
    actualizado: toExcelValue(contact.updatedAt || conversationData.updatedAt || ""),
    conversationId: contact.conversationId || conversation?.id || "",
    conversationDocId: conversation?.id || "",
    lineaWhatsAppId:
      contact.scopedPhoneNumberId ||
      conversationData.scopedPhoneNumberId ||
      conversationData.businessPhoneId ||
      "",
    ultimoMensaje: toExcelValue(conversationData.lastMessageAt || ""),
    ultimoInbound: toExcelValue(conversationData.lastInboundAt || ""),
    ultimoTexto: conversationData.lastMessageText || "",
    direccionUltimoMensaje: conversationData.lastMessageDirection || "",
    etapa: conversationData.stage || "",
    etiquetas: toExcelValue(conversationData.labels || []),
    asignadoNombre: conversationData.assignedToName || "",
    asignadoEmail: conversationData.assignedToEmail || conversationData.assignedEmail || "",
    asignadoUid: conversationData.assignedToUid || conversationData.assignedUid || "",
    vendidoPorNombre: conversationData.soldByName || "",
    vendidoPorEmail: conversationData.soldByEmail || "",
    cantidadDocsContactosUnificados: group.docs.length,
    contactDocIds: contactDocIds.join(" | "),
  };

  return {
    ...base,
    ...flattenObject(contact, "contact"),
    ...flattenObject(conversationData, "conversation"),
  };
}

function buildRawContactRow(doc) {
  return {
    contactDocId: doc.id,
    contactoKey: contactKey(doc.id, doc.data),
    ...flattenObject(doc.data, "contact"),
  };
}

function autoFitColumns(sheet, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  sheet["!cols"] = headers.map((header) => {
    const maxLen = Math.min(
      60,
      Math.max(
        String(header).length,
        ...rows.slice(0, 1000).map((row) => String(row?.[header] ?? "").slice(0, 60).length)
      )
    );
    return { wch: Math.max(10, maxLen + 2) };
  });
}

async function main() {
  console.log("Leyendo colección contacts...");
  const contactDocs = await fetchAllContacts();
  console.log(`Docs contacts leídos: ${contactDocs.length}`);

  const groups = buildGroups(contactDocs);
  console.log(RAW_MODE ? `Modo raw: ${groups.length} filas` : `Contactos unificados: ${groups.length}`);

  let conversationsById = new Map();
  if (INCLUDE_CONVERSATIONS) {
    const convIds = groups.flatMap(candidateConversationIdsForGroup);
    console.log(`Buscando conversations relacionadas por ID: ${new Set(convIds).size}`);
    conversationsById = await fetchConversationsByIds(convIds);
    console.log(`Conversations encontradas: ${conversationsById.size}`);
  }

  const unifiedRows = groups.map((group) =>
    buildUnifiedRow(group, pickConversationForGroup(group, conversationsById))
  );
  const rawRows = contactDocs.map(buildRawContactRow);

  const wb = XLSX.utils.book_new();

  const unifiedSheet = XLSX.utils.json_to_sheet(
    unifiedRows.length ? unifiedRows : [{ aviso: "Sin contactos" }]
  );
  autoFitColumns(unifiedSheet, unifiedRows);
  XLSX.utils.book_append_sheet(
    wb,
    unifiedSheet,
    RAW_MODE ? "Contacts raw principal" : "Contactos unificados"
  );

  const rawSheet = XLSX.utils.json_to_sheet(rawRows.length ? rawRows : [{ aviso: "Sin contactos" }]);
  autoFitColumns(rawSheet, rawRows);
  XLSX.utils.book_append_sheet(wb, rawSheet, "Docs contacts raw");

  const summaryRows = [
    { metrica: "docs_contacts_leidos", valor: contactDocs.length },
    { metrica: "filas_principales", valor: unifiedRows.length },
    { metrica: "modo_raw", valor: RAW_MODE ? "SI" : "NO" },
    { metrica: "incluye_conversations", valor: INCLUDE_CONVERSATIONS ? "SI" : "NO" },
    { metrica: "fecha_exportacion", valor: new Date().toISOString() },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "Resumen");

  const outPath = path.isAbsolute(OUT_FILE) ? OUT_FILE : path.resolve(backendRoot, OUT_FILE);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);

  console.log(`\nOK. Excel generado en:\n${outPath}\n`);
}

main().catch((error) => {
  console.error("\nError exportando contactos:");
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
