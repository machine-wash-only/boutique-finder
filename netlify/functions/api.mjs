// Sign-in check and the shared wholesale pipeline.
import { getStore } from "@netlify/blobs";
import {
  authenticate, limits, getUsage, listPipeline, upsertItem, deleteItem, json,
} from "../lib/core.js";

const env = k => (globalThis.Netlify?.env?.get(k)) ?? process.env[k];

export default async (req) => {
  const url = new URL(req.url);
  const user = authenticate(req, env);
  if (!user) return json({ code: "bad_code", message: "That access code isn't recognized." }, 401);

  // POST /api/login -> who you are + today's usage
  if (url.pathname === "/api/login") {
    const used = await getUsage(getStore({ name: "usage", consistency: "strong" }), user);
    return json({ name: user.name, role: user.role, limits: limits(env), used });
  }

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

export const config = { path: ["/api/login", "/api/pipeline", "/api/pipeline/*"] };
