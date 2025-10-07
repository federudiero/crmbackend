// api/notifyInbound.js
import { db } from "../lib/firebaseAdmin.js"; // ya tenés Admin inicializado
import admin from "firebase-admin";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method_not_allowed" });

  try {
    const { conversationId, title, body, url } = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    if (!conversationId) return res.status(400).json({ ok:false, error:"missing_conversationId" });

    // 1) Buscar la conversación para saber a quién está asignada
    const convRef = db.collection("conversations").doc(conversationId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) return res.status(404).json({ ok:false, error:"conversation_not_found" });

    const assignedToUid = convSnap.get("assignedToUid");
    if (!assignedToUid) return res.status(200).json({ ok:true, skipped:"no_assignee" });

    // 2) Leer tokens del usuario asignado
    const pushDoc = await db.doc(`users/${assignedToUid}/meta/push`).get();
    const tokens = pushDoc.exists ? (pushDoc.get("tokens") || []) : [];
    if (!tokens.length) return res.status(200).json({ ok:true, skipped:"no_tokens" });

    // 3) Construir payload
    const link = url || `http://localhost:5174/?conv=${encodeURIComponent(conversationId)}`; // en prod poné tu dominio https
    const message = {
      tokens,
      notification: {
        title: title || "Nuevo mensaje",
        body:  body  || "Toca para abrir la conversación",
      },
      data: { url: link, convId: conversationId },
      webpush: { fcmOptions: { link } },
    };

    const resp = await admin.messaging().sendEachForMulticast(message);

    // 4) Limpiar tokens inválidos
    const invalid = [];
    resp.responses.forEach((r, i) => { if (!r.success) invalid.push(tokens[i]); });
    if (invalid.length) {
      await db.doc(`users/${assignedToUid}/meta/push`).set(
        { tokens: tokens.filter(t => !invalid.includes(t)) },
        { merge: true }
      );
    }

    return res.status(200).json({ ok:true, sent: resp.successCount, fail: resp.failureCount });
  } catch (e) {
    console.error("notifyInbound error:", e);
    return res.status(500).json({ ok:false, error:e.message });
  }
}
