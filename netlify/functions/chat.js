// netlify/functions/chat.js
//
// Serverless proxy to Anthropic's Claude API.
// The browser POSTs { prompt } here; this function adds the secret API key
// (held in the ANTHROPIC_API_KEY environment variable, never shipped to the client)
// and returns { text }.
//
// Model: Claude Haiku (fast + low cost). Change MODEL below to swap.
//
// Required Netlify env var:  ANTHROPIC_API_KEY
// (Site settings → Environment variables → Add a variable)

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

// ── Basic per-IP rate limiting ───────────────────────────────────────────────
// This is an in-memory sliding-window limiter. It lives in the function's warm
// instance, so it's a lightweight deterrent against casual abuse — NOT a hard
// guarantee (Netlify may spin up multiple instances, each with its own counter,
// and cold starts reset it). For strong limits, back this with a shared store
// (Upstash Redis, Netlify Blobs, etc.). See note at the bottom of this file.
const WINDOW_MS = 60 * 1000;   // 1 minute window
const MAX_PER_WINDOW = 8;      // requests per IP per window
const MAX_PER_DAY = 200;       // soft per-IP daily cap
const DAY_MS = 24 * 60 * 60 * 1000;

const hits = new Map();        // ip -> number[] (timestamps, last WINDOW_MS)
const daily = new Map();       // ip -> { count, resetAt }

function rateLimit(ip) {
  const now = Date.now();

  // Sliding window (per minute)
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(ip, arr);
    return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - arr[0])) / 1000), reason: "minute" };
  }
  arr.push(now);
  hits.set(ip, arr);

  // Daily cap
  let d = daily.get(ip);
  if (!d || now > d.resetAt) d = { count: 0, resetAt: now + DAY_MS };
  if (d.count >= MAX_PER_DAY) {
    daily.set(ip, d);
    return { ok: false, retryAfter: Math.ceil((d.resetAt - now) / 1000), reason: "day" };
  }
  d.count += 1;
  daily.set(ip, d);

  // Opportunistic cleanup so the maps don't grow unbounded on a long-lived instance.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      const keep = v.filter((t) => now - t < WINDOW_MS);
      if (keep.length) hits.set(k, keep); else hits.delete(k);
    }
  }

  return { ok: true };
}

function clientIp(req) {
  const h = req.headers;
  return (
    (h.get("x-nf-client-connection-ip")) ||
    (h.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

export default async (req) => {
  // CORS / preflight
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY." }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // Rate limit per client IP before doing any paid work.
  const ip = clientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    const msg =
      rl.reason === "day"
        ? "Daily request limit reached for your connection. Please try again tomorrow."
        : "You're sending requests too quickly. Please wait a moment and try again.";
    return new Response(JSON.stringify({ error: msg }), {
      status: 429,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Retry-After": String(rl.retryAfter || 30),
      },
    });
  }

  let prompt = "";
  try {
    const body = await req.json();
    prompt = (body && body.prompt) || "";
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!prompt) {
    return new Response(JSON.stringify({ error: "Missing 'prompt'." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "Anthropic API error", detail: detail.slice(0, 300) }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const data = await r.json();
    const text =
      (data && Array.isArray(data.content)
        ? data.content.map((b) => (b && b.type === "text" ? b.text : "")).join("")
        : "") || "";

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Proxy failure", detail: String(e).slice(0, 200) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
};

// ── Upgrading to durable rate limiting ───────────────────────────────────────
// The in-memory limiter above resets on cold starts and isn't shared across
// concurrent instances. To make limits hard, replace the `hits`/`daily` Maps
// with a shared store. Two easy options:
//
//   • Netlify Blobs:  import { getStore } from "@netlify/blobs"
//   • Upstash Redis:  a serverless Redis with a generous free tier
//
// Tune MAX_PER_WINDOW / MAX_PER_DAY at the top of this file to taste.
