import { db, FieldValue } from "./firebaseAdmin.js";
import { normalizeE164AR, buildScopedConversationId } from "./conversationScope.js";
import { buildInboundCrmPatch, buildInboundEvent, getCrmEventRef, parseSmbMessageEcho, recordConfirmedSellerResponse } from "./crmManagement.js";

// No guarda cuerpos de mensajes, medios ni payloads brutos de Meta.
const asDate = value => { const num = Number(value); const d = Number.isFinite(num) && num > 0 ? new Date(num * 1000) : new Date(); return Number.isNaN(d.getTime()) ? new Date() : d; };
export async function processStatisticsOnly(body) {
  const changes = (Array.isArray(body?.entry) ? body.entry : []).flatMap(entry => Array.isArray(entry?.changes) ? entry.changes : []);
  let incoming = 0, echoes = 0;
  for (const change of changes) {
    const value = change?.value || {};
    const phoneId = String(value?.metadata?.phone_number_id || '').trim();
    if (change?.field === 'smb_message_echoes') {
      for (const item of (Array.isArray(value?.message_echoes) ? value.message_echoes : [])) {
        const echo = parseSmbMessageEcho(value, item);
        if (!echo) continue;
        await recordConfirmedSellerResponse({ phone: echo.phone, phoneId: echo.phoneId, messageId: echo.messageId, occurredAt: echo.occurredAt, source: 'whatsapp_business_app', type: echo.type, metadataOnly: true });
        echoes++;
      }
      continue;
    }
    if (change?.field !== 'messages' || !phoneId) continue;
    for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
      const phone = normalizeE164AR(message?.from);
      const messageId = String(message?.id || '').trim();
      if (!phone || !messageId) continue;
      const id = buildScopedConversationId(phone, phoneId);
      if (!id) continue;
      const occurredAt = asDate(message?.timestamp);
      const convRef = db.collection('conversations').doc(id);
      const eventRef = getCrmEventRef('meta_in_' + messageId);
      // Sólo se guardan campos de atribución, identificadores y horas.
      const minimalMessage = { id: messageId, type: message?.type || 'unknown', ...(message?.referral ? { referral: {
        source_id: message.referral.source_id || null, source_type: message.referral.source_type || null,
        headline: message.referral.headline || null,
        ctwa_clid: message.referral.ctwa_clid || null,
      }} : {}) };
      await db.runTransaction(async tx => {
        const [snap, eventSnap] = await Promise.all([tx.get(convRef), tx.get(eventRef)]);
        if (eventSnap.exists) return;
        const data = snap.exists ? snap.data() || {} : {};
        const { patch } = buildInboundCrmPatch({ data, isNew: !snap.exists, occurredAt, message: minimalMessage, value });
        const safePatch = { ...patch };
        // No atribuir tráfico directo por ausencia de evidencia.
        if (!minimalMessage.referral && !data.leadSource) safePatch.leadSource = 'sin_identificar';
        // firstReferral/lastReferral desde buildInboundCrmPatch sólo contienen la referencia recortada.
        const conversationPatch = {
          ...safePatch, phone, contactPhone: phone, businessPhoneId: phoneId,
          ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
          updatedAt: FieldValue.serverTimestamp(),
        };
        tx.set(convRef, conversationPatch, { merge: true });
        tx.create(eventRef, buildInboundEvent({ eventKey: 'meta_in_' + messageId, conversationId: id, contactPhone: phone,
          message: minimalMessage, value, isNew: !snap.exists,
          assignedToUid: data.assignedToUid || null, assignedToEmail: data.assignedToEmail || null, occurredAt }));
      });
      incoming++;
    }
  }
  return { incoming, echoes };
}
