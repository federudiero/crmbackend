// api/purgeConversations.js
// Borra conversaciones y su subcolección /messages por rango de fechas.
// Seguridad: admite (A) header X-Admin-Key (env ADMIN_TASKS_KEY) o
//            (B) Bearer Firebase ID Token + allowlist de emails (env PURGE_ADMIN_EMAILS) o custom claim admin.

import admin, { db } from "../lib/firebaseAdmin.js";

// ====== CORS ======
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};
const setCors = (res) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
};

const ADMIN_KEY = process.env.ADMIN_TASKS_KEY || "";
const PURGE_ADMIN_EMAILS = (process.env.PURGE_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function safeJsonBody(req) {
    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body || "{}");
        } catch {
            body = {};
        }
    }
    if (!body || typeof body !== "object") body = {};
    return body;
}

function toTimestamp(v) {
    // Acepta ISO string, millis, Date, Firestore Timestamp
    if (!v) return null;
    if (typeof v?.toMillis === "function") return v;
    if (typeof v === "number" && Number.isFinite(v)) return admin.firestore.Timestamp.fromMillis(v);
    if (typeof v === "string") {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) return admin.firestore.Timestamp.fromDate(d);
        return null;
    }
    if (v instanceof Date && !Number.isNaN(v.getTime())) return admin.firestore.Timestamp.fromDate(v);
    return null;
}

async function authorize(req) {
    // (A) X-Admin-Key
    const xKey = req.headers["x-admin-key"] || req.headers["X-Admin-Key"];
    if (ADMIN_KEY && xKey && String(xKey) === String(ADMIN_KEY)) {
        return { ok: true, via: "x-admin-key", decoded: null };
    }

    // (B) Bearer token
    const authH = req.headers.authorization || "";
    const idToken = authH.startsWith("Bearer ") ? authH.slice(7) : null;
    if (!idToken) return { ok: false, status: 401, error: "Missing Bearer token (o X-Admin-Key)" };

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { ok: false, status: 401, error: "Invalid token" };
    }

    const email = String(decoded?.email || "").toLowerCase();
    const isAllowlisted = PURGE_ADMIN_EMAILS.includes(email);
    const hasAdminClaim = decoded?.admin === true || decoded?.isAdmin === true || decoded?.role === "admin";

    if (!isAllowlisted && !hasAdminClaim) {
        return { ok: false, status: 403, error: "Forbidden (no admin)" };
    }

    return { ok: true, via: "firebase-auth", decoded };
}

async function deleteMessagesSubcollection(convRef, bw, { pageSize = 800 } = {}) {
    let deleted = 0;
    let lastDoc = null;
    const col = convRef.collection("messages");

    while (true) {
        let q = col.orderBy("__name__").limit(pageSize);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        for (const d of snap.docs) bw.delete(d.ref);
        deleted += snap.size;
        lastDoc = snap.docs[snap.docs.length - 1];

        // Flush para no acumular una cola gigante
        await bw.flush();
    }

    return deleted;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const auth = await authorize(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error || "unauthorized" });

    const body = safeJsonBody(req);
    const {
        // Rango explícito
        from,
        to,
        // O rango automático: desde la primera conversación + N meses
        autoFromFirst = false,
        months = 3,
        // Campo a usar para el rango
        timestampField = "createdAt",
        // Paginación
        limit = 5,
        cursorId = null,
        // Ejecución
        dryRun = true,
        // Para evitar borrar accidentalmente TODO
        requireConfirm = true,
        confirmText = "",
    } = body;

    if (requireConfirm && !dryRun) {
        // Pequeño “seguro”: el cliente debe mandar confirmText="BORRAR"
        if (String(confirmText || "").toUpperCase() !== "BORRAR") {
            return res.status(400).json({
                error: "confirm_required",
                message: "Para ejecutar borrado real, enviá confirmText=\"BORRAR\" (o poné dryRun=true).",
            });
        }
    }

    let fromTs = toTimestamp(from);
    let toTs = toTimestamp(to);

    // Si pidieron ventana automática
    if ((!fromTs || !toTs) && autoFromFirst) {
        const firstSnap = await db
            .collection("conversations")
            .orderBy(timestampField)
            .limit(1)
            .get();

        if (firstSnap.empty) {
            return res.status(200).json({ ok: true, matched: 0, message: "No hay conversaciones." });
        }

        const firstDoc = firstSnap.docs[0];
        const firstVal = firstDoc.get(timestampField);
        const firstTs = toTimestamp(firstVal);
        if (!firstTs) {
            return res.status(400).json({
                error: "cannot_compute_first",
                message: `No se pudo calcular 'from' desde ${timestampField}. Probá con timestampField='createdAt'.`,
            });
        }

        const fromDate = firstTs.toDate();
        const toDate = new Date(fromDate);
        toDate.setMonth(toDate.getMonth() + Math.max(1, Number(months) || 3));

        fromTs = firstTs;
        toTs = admin.firestore.Timestamp.fromDate(toDate);
    }

    if (!fromTs || !toTs) {
        return res.status(400).json({
            error: "missing_range",
            message: "Falta rango. Enviá {from,to} (ISO/millis) o autoFromFirst=true.",
        });
    }

    const pageSize = Math.min(Math.max(Number(limit) || 5, 1), 25);

    let q = db
        .collection("conversations")
        .where(timestampField, ">=", fromTs)
        .where(timestampField, "<=", toTs)
        .orderBy(timestampField)
        .limit(pageSize);

    if (cursorId) {
        const cSnap = await db.collection("conversations").doc(String(cursorId)).get();
        if (cSnap.exists) q = q.startAfter(cSnap);
    }

    const snap = await q.get();
    const docs = snap.docs;

    const sample = docs.slice(0, 10).map((d) => {
        const v = d.get(timestampField);
        const ts = toTimestamp(v);
        return {
            id: d.id,
            path: `conversations/${d.id}`,
            tsMillis: ts?.toMillis ? ts.toMillis() : null,
            lastMessageText: d.get("lastMessageText") || null,
        };
    });

    const nextCursorId = docs.length ? docs[docs.length - 1].id : null;

    if (dryRun) {
        return res.status(200).json({
            ok: true,
            mode: "dryRun",
            matched: docs.length,
            sample,
            nextCursorId,
            range: { fromMillis: fromTs.toMillis(), toMillis: toTs.toMillis(), timestampField },
            note: "No se borró nada. Mandá dryRun=false y confirmText=\"BORRAR\" para ejecutar.",
        });
    }

    // ===== BORRADO REAL =====
    const bw = db.bulkWriter();

    let deletedConversations = 0;
    let deletedMessages = 0;

    try {
        for (const d of docs) {
            const convRef = d.ref;
            deletedMessages += await deleteMessagesSubcollection(convRef, bw);
            bw.delete(convRef);
            deletedConversations += 1;
            await bw.flush();
        }

        await bw.close();

        return res.status(200).json({
            ok: true,
            deletedConversations,
            deletedMessages,
            processed: docs.length,
            sample,
            nextCursorId,
            range: { fromMillis: fromTs.toMillis(), toMillis: toTs.toMillis(), timestampField },
        });
    } catch (e) {
        console.error("[purgeConversations] error:", e);
        try {
            await bw.close();
        } catch {
            /* ignore */
        }
        return res.status(500).json({ error: String(e?.message || e) });
    }
}
