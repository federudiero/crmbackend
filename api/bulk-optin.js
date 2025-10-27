// pages/api/admin/bulk-optin.js  (o /api/admin/bulk-optin.js si usás middleware custom)
// Recorre conversations y marca optIn=true (y optInAt). Refleja en contacts.
// Autenticación por header X-Admin-Key con env ADMIN_TASKS_KEY.

import { db, FieldValue } from "../lib/firebaseAdmin.js"; // ajustá la ruta a tu helper admin
const ADMIN_KEY = process.env.ADMIN_TASKS_KEY || "";

function chunk(arr, size = 10){ const o=[]; for(let i=0;i<arr.length;i+=size) o.push(arr.slice(i,i+size)); return o; }

export default async function handler(req, res){
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // seguridad simple
  if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY){
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apply = (req.query.apply === "true");
  const labels = (req.query.labels || "").split(",").map(s=>s.trim()).filter(Boolean);
  const hardLimit = parseInt(req.query.limit || "0", 10) || 0;

  const ts = FieldValue.serverTimestamp();
  const bw = db.bulkWriter();

  let scanned = 0, modified = 0;

  try {
    const coll = db.collection("conversations");

    if (labels.length){
      // por etiquetas en tandas de 10
      for (const group of chunk(labels, 10)){
        const q = coll.where("labels", "array-contains-any", group).limit(1000);
        const seen = new Set();
        const snap = await q.get();
        for (const d of snap.docs){
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          scanned++;
          if (hardLimit && scanned > hardLimit) break;
          const already = d.get("optIn") === true;
          if (!already){
            modified++;
            if (apply){
              bw.set(d.ref, { optIn: true, optInAt: ts }, { merge: true });
              bw.set(db.collection("contacts").doc(d.id), { optIn: true, optInAt: ts }, { merge: true });
            }
          }
        }
        if (hardLimit && scanned >= hardLimit) break;
      }
    } else {
      // todos (paginando por documentId)
      let lastId = null;
      const pageSize = 1000;

      while (true){
        let q = coll.orderBy("__name__").limit(pageSize);
        if (lastId) q = q.startAfter(lastId);
        const snap = await q.get();
        if (snap.empty) break;

        for (const d of snap.docs){
          scanned++;
          if (hardLimit && scanned > hardLimit) break;
          const already = d.get("optIn") === true;
          if (!already){
            modified++;
            if (apply){
              bw.set(d.ref, { optIn: true, optInAt: ts }, { merge: true });
              bw.set(db.collection("contacts").doc(d.id), { optIn: true, optInAt: ts }, { merge: true });
            }
          }
        }
        lastId = snap.docs[snap.docs.length - 1].id;
        if (hardLimit && scanned >= hardLimit) break;
      }
    }

    if (apply) await bw.close(); else await bw.flush();

    return res.status(200).json({
      ok: true,
      dryRun: !apply,
      scanned,
      toSet: modified
    });
  } catch (e){
    console.error(e);
    try { await bw.close(); } catch {}
    return res.status(500).json({ error: String(e.message || e) });
  }
}
