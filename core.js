// Shared server logic for the MWO Boutique Finder.
// Used by the edge function (Claude proxy) and the regular function (login + pipeline).
// No platform imports here, so it can be tested in plain Node.

export const DEFAULTS = {
  model: "claude-sonnet-5-5",
  searchLimit: 25,   // web searches per access code per day
  draftLimit: 150,   // drafts / briefs per access code per day
  maxWebSearches: 8, // web lookups Claude may make inside one store search
};

/* ---------------- access codes ----------------
   ACCESS_CODES env var, comma-separated entries of  name:code[:admin]
   e.g.  amy:cobalt-dot-4417:admin, chakiboo:knee-patch-2291
   "name" doubles as the client's pipeline workspace, so name client codes after the brand. */
export function parseCodes(raw) {
  const map = new Map();
  for (const entry of String(raw || "").split(",")) {
    const [name, code, role] = entry.trim().split(":").map(s => (s || "").trim());
    if (!name || !code) continue;
    map.set(code, { name: slug(name), role: role === "admin" ? "admin" : "client" });
  }
  return map;
}

export function authenticate(req, env) {
  const code = (req.headers.get("x-access-code") || "").trim();
  if (!code) return null;
  return parseCodes(env("ACCESS_CODES")).get(code) || null;
}

export function limits(env) {
  const n = (k, d) => { const v = parseInt(env(k) || "", 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return { search: n("DAILY_SEARCH_LIMIT", DEFAULTS.searchLimit), draft: n("DAILY_DRAFT_LIMIT", DEFAULTS.draftLimit) };
}

export const day = () => new Date().toISOString().slice(0, 10);

export async function getUsage(store, user) {
  const u = await store.get(`${user.name}/${day()}`, { type: "json" });
  return { search: u?.search || 0, draft: u?.draft || 0 };
}
export async function addUsage(store, user, kind) {
  const key = `${user.name}/${day()}`;
  const u = (await store.get(key, { type: "json" })) || {};
  u[kind] = (u[kind] || 0) + 1;
  await store.setJSON(key, u);
  return u;
}

/* ---------------- helpers ---------------- */
export function slug(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "")
    .trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "x";
}
const clip = (v, n = 400) => String(v ?? "").slice(0, n);
const clipList = (v, n = 12, len = 120) => (Array.isArray(v) ? v : []).slice(0, n).map(x => clip(x, len));

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/* ---------------- prompts (built server-side so the key can only be used for this tool) ---------------- */
function brandCtx(b = {}) {
  return `Brand: ${clip(b.brand, 80)}
Product: ${clip(b.product, 400)}
Retail price: ${clip(b.price, 40)}
Target regions: ${clip(b.regions, 300)}
Desired store vibe: ${clip(b.keywords, 300)}
Shelf-neighbor brands (brands they want to sit next to): ${clip(b.neighbors, 300)}
Avoid: ${clip(b.avoid, 200)}`;
}

function storeCtx(s = {}) {
  const neighbors = (Array.isArray(s.neighbor_matches) ? s.neighbor_matches : []).map(m => clip(m?.brand, 60));
  return `Store: ${clip(s.name, 120)}, ${[s.neighborhood, s.city, s.state].filter(Boolean).map(x => clip(x, 60)).join(", ")}
Website: ${clip(s.website, 200) || "unknown"}
Brands carried: ${[...clipList(s.brands_carried, 10, 60), ...neighbors].join(", ")}
Why it fits: ${clipList(s.fit_reasons, 4, 200).join("; ")}
Suggested pitch: ${clip(s.pitch_angle, 300)}`;
}

export function buildSearch(i = {}) {
  const n = Math.max(3, Math.min(15, parseInt(i.count, 10) || 10));
  const neighbors = String(i.neighbors || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 8);
  const modeRules = i.mode === "neighbors"
    ? `SEARCH MODE: SHELF NEIGHBORS. Only include stores that currently stock at least one of these brands: ${neighbors.join(", ")}. The best evidence is each brand's own stockist or store-locator page, and the store's own site or Instagram. A store carrying several of them ranks highest; fit to the brand's price and customer is the tie-breaker.`
    : `SEARCH MODE: BEST FIT. Rank by overall fit. Shelf-neighbor overlap is one strong signal among several.`;
  const system = `You are a wholesale strategist for small apparel brands. You find real, currently operating independent boutiques using web search, and you never invent stores, URLs or Instagram handles.`;
  const prompt = `Find independent specialty boutiques that would be a strong wholesale fit for this brand.

${brandCtx(i)}

${modeRules}

How to work:
- Use web search to find candidate stores in the target regions and to confirm each one exists and is operating (recent website, Google listing, or Instagram activity). Be efficient: you have a limited number of searches.
- Check shelf neighbors via brand stockist pages or the store's own site where you can.
- Skip anything in the Avoid list, plus department stores and national chains.

Output rules:
- Return up to ${n} stores. If you only find fewer good matches, return fewer.
- website and instagram: only values you actually saw; otherwise "".
- confidence: "known" if you confirmed the store is operating, otherwise "check".
- neighbor_matches: shelf-neighbor brands this store stocks (exact spelling from the list); certainty "known" if you saw evidence, "likely" if it fits their assortment but you couldn't confirm. Never pad.
- brands_carried: up to 6 other notable brands you saw them stock.
- fit_score 0–100 weighing customer match, price point, shelf neighbors, and store vibe.
- fit_reasons: 2–3 short, specific reasons. pitch_angle: one sentence on how this brand should pitch this store.
- sources: 1–3 URLs that back up the store details.

When you have finished searching, your final message must be ONLY a JSON array (no prose, no code fence), each item shaped like:
{"name":"","neighborhood":"","city":"","state":"","website":"","instagram":"","brands_carried":[""],"neighbor_matches":[{"brand":"","certainty":"known"}],"price_tier":"","fit_score":0,"fit_reasons":[""],"pitch_angle":"","confidence":"known","sources":[""]}`;
  return { system, prompt, web: true, maxTokens: 16000 };
}

export function buildDraft(kind, i = {}) {
  const b = brandCtx(i.brandInputs || {});
  const s = storeCtx(i.store || {});
  const system = `You help the founder of a small apparel brand win and manage wholesale accounts with independent boutiques. Write in plain text with no markdown symbols.`;
  if (kind === "outreach") return { system, maxTokens: 3000, prompt:
`Write wholesale outreach from the founder to this boutique's buyer.
${b}
${s}

Give three parts with plain-text headings:
EMAIL — a subject line and a short email (under 130 words): specific to this store, one concrete product hook, mention a brand they already carry if relevant, and a low-commitment ask (drop off samples or a 15-minute visit). Warm, not salesy. Sign as [Founder name].
INSTAGRAM DM — under 60 words.
FOLLOW-UP — a 2-sentence nudge to send 7 days later.` };
  if (kind === "brief") return { system, maxTokens: 3000, prompt:
`Write a one-page visit-prep brief for the founder walking into this boutique to pitch wholesale.
${b}
${s}

Plain-text headings, short bullets:
THE STORE — what it likely is and who shops there (flag anything to verify).
WHY US — 2–3 points of fit, including shelf neighbors they already stock.
OPENING LINE — one sentence to say to the owner or buyer.
BRING — samples and leave-behinds.
LIKELY QUESTIONS — 3 buyer questions with short answers (minimums, margins, reorders, delivery).
IN-STORE IDEAS — 2 ways to merchandise or market the product in this shop.` };
  if (kind === "nextmsg") {
    const p = i.pipeline || {};
    return { system, maxTokens: 2500, prompt:
`Write the right next message for where this store is in the wholesale pipeline.
${b}
${s}
Pipeline stage: ${clip(p.stage, 40)}
Stage history: ${clip(p.history, 400)}
Opening order: ${clip(p.orderValue, 40) || "none yet"}
Founder's notes: ${clip(p.notes, 1500) || "(none)"}
Today: ${day()}

Guidance by stage: Prospect = a first intro email. Contacted = a short, friendly follow-up that adds one new reason to reply. Samples left = a check-in that asks for feedback and an opening order. Ordered = ask how it's selling and offer help (restock, in-store display, social post). Reorder due = a reorder nudge with something new to offer. Passed = a light-touch note to reopen next season.
Use the founder's notes when they help. Give a subject line and an email under 120 words, then a one-line text or DM version. Sign as [Founder name].` };
  }
  return null;
}

export function anthropicBody(spec, env) {
  const body = {
    model: env("CLAUDE_MODEL") || DEFAULTS.model,
    max_tokens: spec.maxTokens,
    stream: true,
    system: spec.system,
    messages: [{ role: "user", content: spec.prompt }],
  };
  if (spec.web) {
    const m = parseInt(env("MAX_WEB_SEARCHES") || "", 10);
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: Number.isFinite(m) && m > 0 ? m : DEFAULTS.maxWebSearches }];
  }
  return body;
}

/* ---------------- stream translation ----------------
   Turns Anthropic's SSE stream into small NDJSON lines for the page:
   {"t":"text","d":"..."}  {"t":"break"} (a web search started)  {"t":"search","q":"..."}
   {"t":"results"}  {"t":"done","stop":"end_turn"}  {"t":"error","message":"..."}
   Big search-result payloads are skipped without parsing to stay inside edge CPU limits. */
export function translateStream(upstream) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  const blocks = new Map(); // index -> {type, json}
  const out = (ctrl, o) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));

  function handle(ctrl, evt) {
    let event = "", data = "";
    for (const line of evt.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    if (event === "content_block_start") {
      if (data.includes('"web_search_tool_result"')) { out(ctrl, { t: "results" }); return; }
      const d = JSON.parse(data);
      blocks.set(d.index, { type: d.content_block?.type, json: "" });
      if (d.content_block?.type === "server_tool_use") out(ctrl, { t: "break" });
      return;
    }
    if (event === "content_block_delta") {
      if (data.includes('"thinking_delta"') || data.includes('"signature_delta"') || data.includes('"citations_delta"')) return;
      const d = JSON.parse(data);
      if (d.delta?.type === "text_delta") out(ctrl, { t: "text", d: d.delta.text });
      else if (d.delta?.type === "input_json_delta") { const b = blocks.get(d.index); if (b) b.json += d.delta.partial_json || ""; }
      return;
    }
    if (event === "content_block_stop") {
      const d = JSON.parse(data); const b = blocks.get(d.index);
      if (b?.type === "server_tool_use") { try { out(ctrl, { t: "search", q: JSON.parse(b.json || "{}").query || "" }); } catch { /* ignore */ } }
      blocks.delete(d.index);
      return;
    }
    if (event === "message_delta") {
      const d = JSON.parse(data);
      if (d.delta?.stop_reason) out(ctrl, { t: "done", stop: d.delta.stop_reason });
      return;
    }
    if (event === "error") {
      let msg = "Claude ran into a problem. Try again.";
      try { const d = JSON.parse(data); if (d.error?.type === "overloaded_error") msg = "Claude is busy right now. Try again in a minute."; } catch {}
      out(ctrl, { t: "error", message: msg });
    }
  }

  return new ReadableStream({
    async start(ctrl) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const evt = buf.slice(0, i); buf = buf.slice(i + 2);
            try { handle(ctrl, evt); } catch { /* skip a malformed event */ }
          }
        }
        if (buf.trim()) { try { handle(ctrl, buf); } catch {} }
      } catch {
        out(ctrl, { t: "error", message: "The connection to Claude dropped. Try again." });
      } finally {
        ctrl.close();
      }
    },
  });
}

export function upstreamError(status, body) {
  const type = body?.error?.type || "";
  if (status === 401 || status === 403) return { status: 500, code: "bad_key", message: "The server's Anthropic API key is missing or invalid. The site owner needs to update it in Netlify." };
  if (status === 429) return { status: 429, code: "rate_limited", message: "Too many requests to Claude right now. Wait a minute and try again." };
  if (status === 529 || type === "overloaded_error") return { status: 503, code: "overloaded", message: "Claude is busy right now. Try again in a minute." };
  if (status === 400 && /credit|billing|balance/i.test(body?.error?.message || "")) return { status: 402, code: "billing", message: "The Anthropic account is out of credit or over its spend limit. The site owner needs to top it up." };
  return { status: 502, code: "upstream", message: "Claude couldn't complete that request. Try again." };
}

/* ---------------- pipeline storage ----------------
   One JSON blob per workspace: key "ws/<workspace>" -> { items: { id: doc } } */
const STAGES = ["prospect", "contacted", "samples", "ordered", "reorder", "passed"];
const DOC_FIELDS = ["brand","name","neighborhood","city","state","website","instagram","price_tier","fit_score","pitch_angle","fit_reasons","brands_carried","neighbor_matches","sources","stage","nextDate","notes","orderValue","history","createdAt","updatedAt","addedBy"];

export function cleanDoc(d = {}) {
  const o = {};
  for (const k of DOC_FIELDS) if (k in d) o[k] = d[k];
  for (const k of ["brand","name","neighborhood","city","state","website","instagram","price_tier","pitch_angle","createdAt","updatedAt","addedBy"]) if (k in o) o[k] = clip(o[k], 300);
  if ("notes" in o) o.notes = clip(o.notes, 4000);
  if ("stage" in o && !STAGES.includes(o.stage)) o.stage = "prospect";
  if ("nextDate" in o) o.nextDate = /^\d{4}-\d{2}-\d{2}$/.test(o.nextDate || "") ? o.nextDate : "";
  if ("orderValue" in o) o.orderValue = o.orderValue == null || o.orderValue === "" ? null : Math.max(0, Number(o.orderValue) || 0);
  if ("fit_score" in o) o.fit_score = o.fit_score == null ? null : Math.max(0, Math.min(100, Number(o.fit_score) || 0));
  for (const k of ["fit_reasons","brands_carried","sources"]) if (k in o) o[k] = clipList(o[k], 10, 300);
  if ("neighbor_matches" in o) o.neighbor_matches = (Array.isArray(o.neighbor_matches) ? o.neighbor_matches : []).slice(0, 10)
    .map(m => ({ brand: clip(m?.brand, 80), certainty: m?.certainty === "known" ? "known" : "likely" }));
  if ("history" in o) o.history = (Array.isArray(o.history) ? o.history : []).slice(-30)
    .map(h => ({ stage: STAGES.includes(h?.stage) ? h.stage : "prospect", at: clip(h?.at, 40) }));
  return o;
}

export function workspaceFor(user, requested, doc) {
  if (user.role !== "admin") return user.name;
  return slug(requested || doc?.brand || user.name);
}

async function readWs(store, ws) {
  return (await store.get(`ws/${ws}`, { type: "json" })) || { items: {} };
}

export async function listPipeline(store, user) {
  const spaces = user.role === "admin"
    ? (await store.list({ prefix: "ws/" })).blobs.map(b => b.key.slice(3))
    : [user.name];
  const items = [];
  for (const ws of spaces) {
    const data = await readWs(store, ws);
    for (const [id, doc] of Object.entries(data.items || {})) items.push({ ...doc, id, workspace: ws });
  }
  return items;
}

export async function upsertItem(store, user, id, doc, requestedWs, merge) {
  const ws = workspaceFor(user, requestedWs, doc);
  const data = await readWs(store, ws);
  const prev = data.items[id];
  if (merge && !prev) return null;
  data.items[id] = merge ? { ...prev, ...cleanDoc(doc) } : cleanDoc(doc);
  if (Object.keys(data.items).length > 2000) throw Object.assign(new Error("full"), { code: "full" });
  await store.setJSON(`ws/${ws}`, data);
  return { ...data.items[id], id, workspace: ws };
}

export async function deleteItem(store, user, id, requestedWs) {
  const ws = workspaceFor(user, requestedWs);
  const data = await readWs(store, ws);
  delete data.items[id];
  await store.setJSON(`ws/${ws}`, data);
}
