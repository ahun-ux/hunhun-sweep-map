import { getStore } from "@netlify/blobs";

const KEY = "progress";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "sweep", consistency: "strong" });
  const load = async () => (await store.get(KEY, { type: "json" })) || { visits: {} };

  if (req.method === "GET") return json(await load());
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const password = String(globalThis.Netlify?.env?.get?.("EDIT_PASSWORD") ?? process.env.EDIT_PASSWORD ?? "").trim();
  if (!password) return json({ error: "no_password" }, 500);

  let a;
  try { a = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  // 密碼放在 body 裡（可以用中文），也相容舊的 header 寫法
  let given = typeof a.pw === "string" ? a.pw : (req.headers.get("x-edit-key") || "");
  try { if (!a.pw) given = decodeURIComponent(given); } catch {}
  if (given.trim() !== password) return json({ error: "unauthorized" }, 401);
  if (a.action === "check") return json({ ok: true });

  if (typeof a.key !== "string" || a.key.length > 40) return json({ error: "bad key" }, 400);
  const data = await load();
  data.visits ||= {};
  const list = (data.visits[a.key] ||= []);

  if (a.action === "add") {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(a.date || "") ? a.date : new Date().toISOString().slice(0, 10);
    const tm = ["hun", "hong", "home"].includes(a.team) ? a.team : "hun";
    list.push({ d, t: Date.now(), tm });
  } else if (a.action === "remove") {
    const i = Number.isInteger(a.index) ? a.index : list.length - 1;
    if (i >= 0 && i < list.length) list.splice(i, 1);
  } else {
    return json({ error: "bad action" }, 400);
  }
  if (!list.length) delete data.visits[a.key];
  data.updated = Date.now();
  await store.setJSON(KEY, data);
  return json(data);
};

export const config = { path: "/api/progress" };
