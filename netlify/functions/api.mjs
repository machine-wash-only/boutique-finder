// Sign-in check, the shared wholesale pipeline, and the admin "Manage access" page.
import { getStore } from "@netlify/blobs";
import {
  authenticate, limits, getUsage, listPipeline, upsertItem, deleteItem, json, day, parseCodes,
  readCodes, createCode, updateCode, deleteCode, touchCode,
} from "../lib/core.js";

const env = k => (globalThis.Netlify?.env?.get(k)) ?? process.env[k];

export default async (req) => {
  const url = new URL(req.url);
  const access = getStore({ name: "access", consistency: "strong" });
  const user = await authenticate(req, env, access);
  if (!user) return json({ code: "bad_code", message: "That access code isn't recognized." }, 401);

  // POST /api/login -> who you are + today's usage
  if (url.pathname === "/api/login") {
    const used = await getUsage(getStore({ name: "usage", consistency: "strong" }), user);
    if (user.source === "managed") { try { await touchCode(access, user.id); } catch {} }
    return json({ name: user.name, role: user.role, limits: limits(env), used });
  }

  if (url.pathname.startsWith("/api/admin/")) return admin(req, url, user, access);

  const store = getStore({ name: "pipeline", consistency: "strong" });
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/pipeline\/?/, ""));
  const ws = url.searchParams.get("ws") || "";

  try {
    if (req.method === "GET" && !id) {
      return json({ items: await listPipeline(store, user) });
    }
    if (!id || !/^[\w.-]{1,190}$/.test(id)) return json({ message: "Missing or bad item id." }, 400);

    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ message: "Bad request." }, 400);
      const item = await upsertItem(store, user, id, body.doc || {}, ws || body.workspace, req.method === "PATCH");
      if (!item) return json({ message: "That store isn't in the pipeline anymore. Refresh the page." }, 404);
      return json({ item });
    }
    if (req.method === "DELETE") {
      await deleteItem(store, user, id, ws);
      return json({ ok: true });
    }
    return json({ message: "Not supported." }, 405);
  } catch (e) {
    if (e?.code === "full") return json({ message: "This pipeline is full. Remove passed stores to make room." }, 413);
    console.log("pipeline error", e);
    return json({ message: "Couldn't save that change. Try again." }, 500);
  }
};

/* ---------------- Manage access (admin only) ----------------
   GET    /api/admin/codes          list codes + usage
   POST   /api/admin/codes          {brand, note} -> new code
   PATCH  /api/admin/codes/<id>     {active?, note?}
   DELETE /api/admin/codes/<id>                                  */
async function admin(req, url, user, access) {
  if (user.role !== "admin") return json({ code: "forbidden", message: "Only the admin code can manage access." }, 403);
  const id = decodeURIComponent(url.pathname.replace(/^\/api\/admin\/codes\/?/, ""));
  if (!url.pathname.startsWith("/api/admin/codes")) return json({ message: "Not found." }, 404);

  try {
    if (req.method === "GET" && !id) {
      const usage = getStore({ name: "usage", consistency: "strong" });
      const { codes } = await readCodes(access);
      const fromEnv = [...parseCodes(env("ACCESS_CODES")).values()];
      const names = [...new Set([...codes.map(c => c.workspace), ...fromEnv.map(u => u.name)])];
      const stats = {};
      await Promise.all(names.map(async n => {
        const [t, a] = await Promise.all([
          usage.get(`${n}/${day()}`, { type: "json" }),
          usage.get(`total/${n}`, { type: "json" }),
        ]);
        stats[n] = { today: t?.search || 0, total: a?.search || 0, drafts: a?.draft || 0 };
      }));
      return json({
        codes,
        netlify: fromEnv.map(u => ({ workspace: u.name, role: u.role })),
        stats,
        limits: limits(env),
      });
    }
    if (req.method === "POST" && !id) {
      const body = await req.json().catch(() => ({}));
      const { entry, shared } = await createCode(access, env, { brand: String(body.brand || "").trim(), note: String(body.note || "").trim() });
      return json({ entry, shared }, 201);
    }
    if (!/^[a-z0-9]{2,40}$/.test(id)) return json({ message: "Missing or bad code id." }, 400);
    if (req.method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const entry = await updateCode(access, id, body || {});
      if (!entry) return json({ message: "That code no longer exists. Refresh the page." }, 404);
      return json({ entry });
    }
    if (req.method === "DELETE") {
      const ok = await deleteCode(access, id);
      return ok ? json({ ok: true }) : json({ message: "That code no longer exists." }, 404);
    }
    return json({ message: "Not supported." }, 405);
  } catch (e) {
    if (e?.code === "bad_input") return json({ message: e.message }, 400);
    console.log("admin error", e);
    return json({ message: "Couldn't save that change. Try again." }, 500);
  }
}

export const config = { path: ["/api/login", "/api/pipeline", "/api/pipeline/*", "/api/admin/codes", "/api/admin/codes/*"] };
