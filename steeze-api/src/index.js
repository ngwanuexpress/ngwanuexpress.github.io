// Steeze API — a Cloudflare Worker that keeps the Anthropic API key
// server-side and turns a user's wardrobe photos into outfit suggestions.
//
// POST /suggest
//   { items: [{ id, name, category, color, tags, image }], occasion, date, weather, note }
//   image is a JPEG data URL (the app shrinks photos before sending).
// → { outfits: [{ title, item_ids, why, tip }], missing }

import Anthropic from "@anthropic-ai/sdk";

const MAX_ITEMS = 60;
const MAX_IMAGE_CHARS = 300_000; // ~220 KB of JPEG per item after base64
const MAX_TEXT = 200;

const OUTFIT_SCHEMA = {
  type: "object",
  properties: {
    outfits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          item_ids: { type: "array", items: { type: "string" } },
          why: { type: "string" },
          tip: { type: "string" },
        },
        required: ["title", "item_ids", "why", "tip"],
        additionalProperties: false,
      },
    },
    missing: { type: "string" },
  },
  required: ["outfits", "missing"],
  additionalProperties: false,
};

const SYSTEM = `You are a friendly personal stylist for people in Nigeria, mostly Lagos.
You receive photos of clothes from the user's own wardrobe, each labelled with an item id.
Suggest up to 3 complete outfits for the occasion, using ONLY the item ids you were given.
Each outfit should normally have a top and bottom (or a one-piece such as a dress, kaftan or agbada), plus shoes if the wardrobe has any.
Consider the weather (Lagos heat, humidity and rain), the occasion's dress code, and Nigerian norms — e.g. native wear for owambe or traditional events, modest options for church or mosque, smart looks for office.
Keep "why" to one or two short sentences and "tip" to one practical styling tip.
In "missing", briefly name one item that would unlock more outfits, or return an empty string if nothing is needed.
If the wardrobe cannot make a sensible outfit, return an empty outfits list and explain in "missing".`;

function clean(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max).trim() : "";
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0] || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function buildContent(items, { occasion, date, weather, note }) {
  const content = [];
  for (const item of items) {
    const label = [item.category, item.color, item.name && `"${item.name}"`, item.tags.length && `tags: ${item.tags.join(", ")}`]
      .filter(Boolean)
      .join(" · ");
    content.push({ type: "text", text: `Item id=${item.id} — ${label}` });
    if (item.image) {
      content.push({ type: "image", source: { type: "base64", media_type: item.mediaType, data: item.image } });
    }
  }
  content.push({
    type: "text",
    text: [
      `Occasion: ${occasion || "everyday"}`,
      date && `Date: ${date}`,
      weather && `Weather: ${weather}`,
      note && `Note from the user: ${note}`,
      "Suggest outfits from the items above.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  return content;
}

function parseItems(raw) {
  if (!Array.isArray(raw)) return null;
  const items = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    const id = clean(it?.id, 64);
    if (!id) continue;
    let image = "";
    let mediaType = "image/jpeg";
    const m = typeof it.image === "string" && it.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (m && m[2].length <= MAX_IMAGE_CHARS) {
      mediaType = m[1];
      image = m[2];
    }
    items.push({
      id,
      name: clean(it.name, 60),
      category: clean(it.category, 30),
      color: clean(it.color, 30),
      tags: Array.isArray(it.tags) ? it.tags.map((t) => clean(t, 30)).filter(Boolean).slice(0, 8) : [],
      image,
      mediaType,
    });
  }
  return items;
}

async function suggest(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400, cors);
  }

  const items = parseItems(body.items);
  if (!items || items.length < 2) return json({ error: "Add at least 2 clothing items first." }, 400, cors);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });

  let response;
  try {
    response = await client.beta.messages.create({
      model: env.MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: env.EFFORT || "low", format: { type: "json_schema", schema: OUTFIT_SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: buildContent(items, {
            occasion: clean(body.occasion, 60),
            date: clean(body.date, 20),
            weather: clean(body.weather, 120),
            note: clean(body.note, 300),
          }),
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The stylist is busy. Try again in a minute." }, 429, cors);
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return json({ error: "The stylist is unavailable right now." }, 502, cors);
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    return json({ error: "The stylist couldn't help with that request." }, 422, cors);
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    console.error("Unparseable model output", response.stop_reason);
    return json({ error: "The stylist gave an unexpected answer. Please try again." }, 502, cors);
  }

  // Drop any ids the model invented so the app only ever shows real wardrobe items.
  const known = new Set(items.map((i) => i.id));
  const outfits = (result.outfits || [])
    .map((o) => ({ ...o, item_ids: (o.item_ids || []).filter((id) => known.has(id)) }))
    .filter((o) => o.item_ids.length > 0);

  return json({ outfits, missing: result.missing || "" }, 200, cors);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/" && request.method === "GET") return json({ ok: true, service: "steeze-api" }, 200, cors);
    if (url.pathname === "/suggest" && request.method === "POST") return suggest(request, env, cors);
    return json({ error: "Not found" }, 404, cors);
  },
};
