import { db, FieldValue } from './firebaseAdmin.js';

function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function num(value) { const text = String(value || '').trim(); return /^\d{8,25}$/.test(text) ? text : ''; }
function settings() {
  const appId = process.env.META_APP_ID || '';
  const secret = process.env.META_APP_SECRET || '';
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '';
  const version = process.env.META_GRAPH_API_VERSION || '';
  if (!/^\d{8,25}$/.test(appId) || !secret || !/^\d{8,25}$/.test(configId) || !/^v\d+\.\d+$/.test(version)) fail('Falta configurar Embedded Signup en el backend', 503);
  return { appId, secret, configId, version };
}
async function graph(version, path, token, method = 'GET') {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: abort.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error) fail('Meta rechazó la autorización o los permisos del número', 502);
    return result;
  } finally { clearTimeout(timer); }
}
export function getCoexistenceConfig() {
  if (process.env.META_COEXISTENCE_PILOT_ENABLED !== 'true') fail('Piloto de coexistencia aún no habilitado por el administrador', 503);
  const { appId, configId, version } = settings();
  return { appId, configId, version, mode: 'whatsapp_business_app_onboarding' };
}
export async function completeCoexistence(actor, payload) {
  if (process.env.META_COEXISTENCE_PILOT_ENABLED !== 'true') fail('Piloto de coexistencia no habilitado', 503);
  // El vendedor debe autorizar expresamente el uso de un teléfono asignado por la empresa.
  if (payload?.businessNumberAuthorized !== true || payload?.mixedUseNoticeAccepted !== true) fail('Falta confirmar autorización y privacidad del número');
  const { appId, secret, version } = settings();
  const code = String(payload?.code || '').trim();
  const wabaId = num(payload?.wabaId);
  const phoneId = num(payload?.phoneNumberId);
  if (!code || code.length > 4096 || !wabaId || !phoneId) fail('Faltan los datos del alta confirmada por Meta');
  const params = new URLSearchParams({ client_id: appId, client_secret: secret, code });
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
  let token;
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/oauth/access_token?${params}`, { signal: ctrl.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) fail('Meta no pudo confirmar la autorización', 502);
    token = result.access_token;
  } finally { clearTimeout(timer); }
  // La declaración del navegador no alcanza: comprobar acceso REAL al activo vía Graph.
  const listed = await graph(version, `${wabaId}/phone_numbers?fields=id,display_phone_number&limit=100`, token);
  const phone = Array.isArray(listed?.data) ? listed.data.find(row => row.id === phoneId) : null;
  if (!phone) fail('El número no pertenece a la cuenta WhatsApp autorizada', 403);
  // No crear un vínculo parcialmente operativo si falla la suscripción.
  await graph(version, `${wabaId}/subscribed_apps`, token, 'POST');
  // Token de intercambio descartado inmediatamente. No se escribe en Firestore ni se devuelve al navegador.
  token = undefined;
  const ref = db.collection('wabaNumbers').doc(phoneId);
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    const data = current.exists ? current.data() || {} : {};
    if (data.ownerUid && data.ownerUid !== actor.uid && !actor.isAdmin) fail('Número ya asignado a otro vendedor', 403);
    tx.set(ref, { waPhoneId: phoneId, phoneId, wabaId, ownerUid: actor.uid, owner: actor.email,
      displayPhoneNumber: String(phone.display_phone_number || ''), mode: 'coexistence', status: 'connected',
      updatedAt: FieldValue.serverTimestamp(), ...(!current.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
      privacy: { metadataOnly: true, mixedUseNoticeAccepted: true } }, { merge: true });
  });
  return { connected: true, phoneId, displayPhoneNumber: String(phone.display_phone_number || '') };
}
