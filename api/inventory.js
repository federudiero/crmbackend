import { authenticateCrmRequest } from '../lib/crmManagement.js';
import { db, FieldValue } from '../lib/firebaseAdmin.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const str = (value, max = 160) => String(value ?? '').trim().slice(0, max);
const integer = (value, name) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) throw fail(`${name} debe ser un entero entre 0 y 1.000.000.000`);
  return n;
};
const money = (value) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000000) throw fail('Precio inválido');
  return Math.round(n * 100) / 100;
};
const serialize = (doc) => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || null, updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString?.() || null });
function cors(res) {
  const allowed = String(process.env.CORS_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);
  const origin = String(res.req?.headers?.origin || '');
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido' });
  try {
    const actor = await authenticateCrmRequest(req);
    if (!actor.isAdmin) throw fail('Solo administradores pueden gestionar el inventario', 403);
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const products = db.collection('inventoryProducts');
    const action = str(input.action, 40);
    if (action === 'list') {
      const snap = await products.orderBy('name').limit(500).get();
      return res.json({ ok: true, products: snap.docs.map(serialize) });
    }
    if (action === 'create') {
      const name = str(input.product?.name);
      if (!name) throw fail('El nombre del producto es obligatorio');
      const sku = str(input.product?.sku, 80);
      const category = str(input.product?.category, 100);
      const unit = str(input.product?.unit, 30) || 'unidad';
      const stock = integer(input.product?.stock ?? 0, 'Stock inicial');
      const minimumStock = integer(input.product?.minimumStock ?? 0, 'Stock mínimo');
      const price = money(input.product?.price);
      const ref = products.doc();
      const movement = ref.collection('movements').doc();
      const batch = db.batch();
      batch.set(ref, { name, sku, category, unit, stock, minimumStock, price, active: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
      batch.set(movement, { type: 'initial', before: 0, after: stock, difference: stock, reason: 'Alta de producto', actorUid: actor.uid, actorEmail: actor.email, createdAt: FieldValue.serverTimestamp() });
      await batch.commit();
      return res.json({ ok: true, id: ref.id });
    }
    if (action === 'update' || action === 'adjust') {
      const id = str(input.id, 150);
      if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw fail('ID de producto inválido');
      const ref = products.doc(id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw fail('Producto no encontrado', 404);
        const before = snap.data();
        if (action === 'update') {
          const name = str(input.product?.name);
          if (!name) throw fail('El nombre es obligatorio');
          tx.update(ref, { name, sku: str(input.product?.sku, 80), category: str(input.product?.category, 100), unit: str(input.product?.unit, 30) || 'unidad', price: money(input.product?.price), minimumStock: integer(input.product?.minimumStock ?? 0, 'Stock mínimo'), active: input.product?.active !== false, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
        } else {
          const after = integer(input.stock, 'Stock nuevo');
          const reason = str(input.reason, 300);
          if (!reason) throw fail('Indicá el motivo del ajuste');
          if (after === before.stock) throw fail('No hay cambios en el stock');
          const movement = ref.collection('movements').doc();
          tx.update(ref, { stock: after, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
          tx.set(movement, { type: 'manual_adjustment', before: before.stock, after, difference: after - before.stock, reason, actorUid: actor.uid, actorEmail: actor.email, createdAt: FieldValue.serverTimestamp() });
        }
      });
      return res.json({ ok: true });
    }
    if (action === 'history') {
      const id = str(input.id, 150);
      if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw fail('ID inválido');
      const snap = await products.doc(id).get();
      if (!snap.exists) throw fail('Producto no encontrado', 404);
      const movements = await snap.ref.collection('movements').orderBy('createdAt', 'desc').limit(50).get();
      return res.json({ ok: true, movements: movements.docs.map(serialize) });
    }
    throw fail('Acción desconocida');
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, error: error.statusCode ? error.message : 'No se pudo completar la operación' });
  }
}
