const digits = (s) => String(s || "").replace(/\D+/g, "");

function normalizeE164AR(raw) {
  let d = digits(raw);
  if (!d) return "";

  if (d.startsWith("549")) return `+${d}`;

  const m5415 = d.match(/^54(\d{2,4})15(\d+)$/);
  if (m5415) {
    const [, area, local] = m5415;
    return `+549${area}${local}`;
  }

  if (d.startsWith("54")) return `+${d}`;
  if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/^0+/, "");

  return d ? `+${d}` : "";
}

function buildScopedConversationId(phoneOrE164, phoneId) {
  const normalizedPhone = normalizeE164AR(phoneOrE164);
  const cleanPhoneId = String(phoneId || "").trim();
  if (!normalizedPhone) return "";
  if (!cleanPhoneId) return normalizedPhone;
  return `${cleanPhoneId}__${digits(normalizedPhone)}`;
}

function normalizePhoneId(phoneId) {
  return String(phoneId || "").trim();
}

function toMillisMaybe(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === "function") {
    try {
      return Number(value.toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  if (typeof value?.toDate === "function") {
    try {
      return Number(value.toDate().getTime()) || 0;
    } catch {
      return 0;
    }
  }
  const dt = new Date(value);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getConversationPhoneId(data = {}) {
  return normalizePhoneId(
    data?.scopedPhoneNumberId ||
      data?.lastInboundPhoneId ||
      data?.businessPhoneId ||
      data?.waPhoneId ||
      ""
  );
}

function getConversationContactPhone(data = {}) {
  return normalizeE164AR(
    data?.contactId ||
      data?.clientPhone ||
      data?.phone ||
      data?.to ||
      ""
  );
}

function rankConversationMatch(entry, { preferredPhoneId = "", preferredConversationId = "" } = {}) {
  const id = String(entry?.id || "");
  const data = entry?.data || {};
  const convoPhoneId = getConversationPhoneId(data);

  let score = 0;

  if (preferredConversationId && id === preferredConversationId) score += 1_000_000_000_000;
  if (preferredPhoneId && convoPhoneId && convoPhoneId === preferredPhoneId) score += 100_000_000_000;
  if (preferredPhoneId && id === buildScopedConversationId(getConversationContactPhone(data), preferredPhoneId)) {
    score += 10_000_000_000;
  }

  score += Number(data?.lastMessageTsMs || 0);
  score += Number(data?.lastInboundTsMs || 0);
  score += toMillisMaybe(data?.updatedAt);
  score += toMillisMaybe(data?.lastMessageAt);
  score += toMillisMaybe(data?.lastInboundAt);
  score += toMillisMaybe(data?.createdAt);

  return score;
}

function pickBestConversation(entries = [], opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return [...entries]
    .sort((a, b) => rankConversationMatch(b, opts) - rankConversationMatch(a, opts))[0];
}

async function getConversationById(db, conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) return null;

  const snap = await db.collection("conversations").doc(id).get();
  if (!snap.exists) return null;

  return {
    id: snap.id,
    data: snap.data() || {},
    normalizedPhone: getConversationContactPhone(snap.data() || {}),
  };
}

async function findConversationsByPhone(db, rawPhone) {
  const normalizedPhone = normalizeE164AR(rawPhone);
  if (!normalizedPhone) return { normalizedPhone: "", matches: [] };

  const matches = [];
  const seen = new Set();

  const pushSnap = (snap) => {
    if (!snap?.exists) return;
    if (seen.has(snap.id)) return;
    seen.add(snap.id);
    matches.push({ id: snap.id, data: snap.data() || {} });
  };

  const legacySnap = await db.collection("conversations").doc(normalizedPhone).get().catch(() => null);
  pushSnap(legacySnap);

  const qSnap = await db
    .collection("conversations")
    .where("contactId", "==", normalizedPhone)
    .get()
    .catch(() => null);

  if (qSnap?.docs?.length) {
    for (const docSnap of qSnap.docs) pushSnap(docSnap);
  }

  return { normalizedPhone, matches };
}

async function resolveConversationContext(
  db,
  { conversationId = "", rawPhone = "", phoneId = "", preferScopedId = false } = {}
) {
  const preferredConversationId = String(conversationId || "").trim();
  const preferredPhoneId = normalizePhoneId(phoneId);

  if (preferredConversationId) {
    const byId = await getConversationById(db, preferredConversationId);
    if (byId) {
      return {
        conversationId: byId.id,
        data: byId.data,
        normalizedPhone: byId.normalizedPhone || normalizeE164AR(rawPhone),
        matchedBy: "conversationId",
        scopedConversationId:
          buildScopedConversationId(byId.normalizedPhone || rawPhone, preferredPhoneId) || byId.id,
      };
    }
  }

  const normalizedPhone = normalizeE164AR(rawPhone);
  const scopedConversationId = buildScopedConversationId(normalizedPhone, preferredPhoneId);

  if (scopedConversationId && preferredPhoneId) {
    const scopedMatch = await getConversationById(db, scopedConversationId);
    if (scopedMatch) {
      return {
        conversationId: scopedMatch.id,
        data: scopedMatch.data,
        normalizedPhone: scopedMatch.normalizedPhone || normalizedPhone,
        matchedBy: "scopedId",
        scopedConversationId,
      };
    }
  }

  const { matches } = await findConversationsByPhone(db, normalizedPhone);
  const best = pickBestConversation(matches, { preferredPhoneId, preferredConversationId });

  if (best) {
    const bestPhoneId = getConversationPhoneId(best.data);
    const shouldForceScopedNew =
      preferScopedId &&
      !preferredConversationId &&
      preferredPhoneId &&
      bestPhoneId &&
      bestPhoneId !== preferredPhoneId;

    if (!shouldForceScopedNew) {
      return {
        conversationId: best.id,
        data: best.data,
        normalizedPhone: getConversationContactPhone(best.data) || normalizedPhone,
        matchedBy: "contactId",
        scopedConversationId,
      };
    }
  }

  return {
    conversationId: preferScopedId ? scopedConversationId || normalizedPhone : normalizedPhone,
    data: null,
    normalizedPhone,
    matchedBy: "none",
    scopedConversationId,
  };
}

function buildContactDocIds({ conversationId = "", normalizedPhone = "" } = {}) {
  const ids = [String(conversationId || "").trim(), String(normalizedPhone || "").trim()].filter(Boolean);
  return [...new Set(ids)];
}

export {
  buildContactDocIds,
  buildScopedConversationId,
  digits,
  findConversationsByPhone,
  getConversationById,
  getConversationContactPhone,
  getConversationPhoneId,
  normalizeE164AR,
  normalizePhoneId,
  pickBestConversation,
  resolveConversationContext,
  toMillisMaybe,
};
