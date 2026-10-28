// Claude proxy. Runs as a Netlify Edge Function so long web searches can stream
// back to the page. The Anthropic API key never leaves the server.
import { getStore } from "@netlify/blobs";
import {
  authenticate, limits, getUsage, addUsage, buildSearch, buildDraft,
  anthropicBody, translateStream, upstreamError, json,
} from "../lib/core.js";

const env = k => Netlify.env.get(k);

export default async (req) => {
  if (req.method !== "POST") return json({ message: "Use POST." }, 405);

  const user = authenticate(req, env);
  if (!user) return json({ code: "bad_code", message: "That access code isn't recognized. Sign in again." }, 401);

  const key = env("ANTHROPIC_API_KEY");
  if (!key) return json({ code: "bad_key", message: "The site owner hasn't added an Anthropic API key in Netlify yet." }, 500);

  let payload;
  try { payload = await req.json(); } catch { return json({ message: "Bad request." }, 400); }
  const { kind, inputs } = payload || {};

  const spec = kind === "search" ? buildSearch(inputs) : buildDraft(kind, inputs);
  if (!spec) return json({ message: "Unknown request type." }, 400);

  const bucket = kind === "search" ? "search" : "draft";
  const usage = getStore({ name: "usage", consistency: "strong" });
  const used = await getUsage(usage, user);
  const max = limits(env)[bucket];
  if (used[bucket] >= max) {
    return json({ code: "limit", message: bucket === "search"
      ? `You've used all ${max} searches for today. They reset at midnight UTC.`
      : `You've used all ${max} drafts for today. They reset at midnight UTC.` }, 429);
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(anthropicBody(spec, env)),
  });

  if (!upstream.ok || !upstream.body) {
    let body = null; try { body = await upstream.json(); } catch {}
    console.log("Anthropic error", upstream.status, body?.error?.type, body?.error?.message);
    const e = upstreamError(upstream.status, body);
    return json({ code: e.code, message: e.message }, e.status);
  }

  await addUsage(usage, user, bucket);

  return new Response(translateStream(upstream.body), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
};

export const config = { path: "/api/claude" };
