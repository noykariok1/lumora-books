// Lumora: likeness-preserving character + page illustration via Google Gemini image model.
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   GEMINI_API_KEY      required
//   GEMINI_IMAGE_MODEL  optional, default "gemini-3-pro-image" (Nano Banana Pro, best identity consistency; cheaper: gemini-nano-banana-2.1)
//   ALLOWED_ORIGINS     optional, comma separated, e.g. "https://lumora.onrender.com,http://localhost:8080"
// Request (POST JSON):
//   { mode: "character", photo: "<base64 jpeg>", gender: "m"|"f", traits?: {...}, notes?: string, variant?: 0..3 }
//   { mode: "page", photo: "<base64>", sheet: "<base64 approved character>", scene: "text", gender, variant?: number }
// Response: { image: "<base64 png/jpeg>", mime: "image/png" } or { error, code }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") || "gemini-3-pro-image";
const KEY = Deno.env.get("GEMINI_API_KEY") || "";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_B64 = 6_000_000; // ~4.5 MB per image

// very small per-isolate rate limit (use Upstash/DB for real limits)
const hits = new Map<string, number[]>();
function limited(ip: string, max = 60, windowMs = 10 * 60_000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

function cors(origin: string | null) {
  const ok = ALLOWED.includes("*") || (origin && ALLOWED.includes(origin));
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, h: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

const STYLE = `Soft, warm, premium children's picture-book illustration: gentle gouache and coloured-pencil texture,
rounded friendly shapes, slightly larger head and eyes than real proportions but clearly the SAME child, warm natural light,
clean uncluttered background, no text, no letters, no watermark, no frame.`;

const LIKENESS = `Keep this exact child's identity from the reference photo: face shape, eye shape and colour, eyebrows, nose,
mouth and smile (including any missing or gapped teeth), skin tone, freckles or marks, hair colour, hair length, hair texture,
fringe/bangs and how the hair is parted or tied, ears, and glasses if worn. A parent must instantly recognise their child.
Do not make the child older, thinner or more "idealised". Do not change ethnicity or skin tone.`;

function characterPrompt(gender: string, traits: unknown, notes: string, variant: number) {
  const poses = [
    "front-facing head-and-shoulders portrait, smiling, looking at the viewer",
    "full-body standing pose, front view, arms relaxed, simple cheerful outfit",
    "three-quarter view, waving happily, full body",
    "front-facing portrait with a big laugh",
  ];
  return `${STYLE}
Create a character reference of the ${gender === "m" ? "boy" : "girl"} in the attached photo.
${LIKENESS}
Pose: ${poses[variant % poses.length]}. Plain very light cream background.
${traits ? `Visible traits already noted by the parent: ${JSON.stringify(traits)}.` : ""}
${notes ? `Distinctive features: ${notes}.` : ""}`;
}

function pagePrompt(gender: string, scene: string) {
  return `${STYLE}
Image 1 is a photo of the real child. Image 2 is the approved illustrated character of that child.
Draw a full picture-book page (landscape 4:3) of THIS SAME character, matching image 2's style, outfit and proportions,
and image 1's face. ${LIKENESS}
The child is large in the foreground, face clearly visible and lit.
Scene: ${scene}
Leave calm space in the sky or background; never add any text.`;
}

const RENDER_RULES = `Children's picture-book illustration. Absolutely no text, letters, numbers, captions, logos or watermarks anywhere in the image.
${LIKENESS}`;

async function callGemini(parts: unknown[], aspect?: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: aspect
        ? { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: aspect } }
        : { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${res.status}`;
    return { error: msg, code: res.status === 429 ? "rate_limited" : "provider_error" };
  }
  const cand = data?.candidates?.[0];
  if (!cand) return { error: "No image returned", code: data?.promptFeedback?.blockReason ? "blocked" : "empty" };
  for (const p of cand.content?.parts || []) {
    const d = p.inlineData || p.inline_data;
    if (d?.data) return { image: d.data, mime: d.mimeType || d.mime_type || "image/png" };
  }
  return { error: "The model did not return an image", code: cand.finishReason === "SAFETY" ? "blocked" : "empty" };
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
  if (!KEY) return json({ error: "GEMINI_API_KEY is not set", code: "not_configured" }, 500, h);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) return json({ error: "Too many requests, try again in a few minutes", code: "rate_limited" }, 429, h);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400, h); }
  const photo = String(body.photo || "");
  if (!photo || photo.length > MAX_B64) return json({ error: "Missing or too large photo" }, 400, h);
  const gender = body.gender === "m" ? "m" : "f";
  const variant = Number(body.variant || 0) | 0;

  let parts: unknown[];
  let aspect: string | undefined;
  if (body.mode === "render") {
    // generic book render: image 1 = child photo/avatar, optional image 2 = approved character reference sheet
    const sheet = String(body.sheet || "");
    if (sheet.length > MAX_B64) return json({ error: "Sheet too large" }, 400, h);
    const prompt = String(body.prompt || "").slice(0, 3000);
    if (!prompt) return json({ error: "Missing prompt" }, 400, h);
    aspect = ["4:5", "16:9", "3:2", "1:1"].includes(String(body.aspect)) ? String(body.aspect) : "4:5";
    const intro = sheet
      ? "Image 1 is the photo (or chosen avatar) of the real child, the hero. Image 2 is the approved character reference sheet for this book: keep every character, outfit, prop, colour and proportion exactly as in image 2, and the hero's face exactly as in image 1."
      : "Image 1 is the photo (or chosen avatar) of the real child, the hero.";
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      ...(sheet ? [{ inline_data: { mime_type: /^image\/(png|jpeg|webp)$/.test(String(body.sheetMime)) ? String(body.sheetMime) : "image/png", data: sheet } }] : []),
      { text: `${intro}\n${RENDER_RULES}\n${prompt}` },
    ];
  } else if (body.mode === "page") {
    const sheet = String(body.sheet || "");
    if (!sheet || sheet.length > MAX_B64) return json({ error: "Missing approved character" }, 400, h);
    const scene = String(body.scene || "a sunny garden").slice(0, 600);
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      { inline_data: { mime_type: "image/png", data: sheet } },
      { text: pagePrompt(gender, scene) },
    ];
  } else {
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      { text: characterPrompt(gender, body.traits, String(body.notes || "").slice(0, 300), variant) },
    ];
  }
  // Photos are not stored by this function. Turn off request logging in the Google project for children's data.
  let out = await callGemini(parts, aspect);
  if ("error" in out && aspect && out.code === "provider_error" && /aspect|imageConfig|Unknown name/i.test(String(out.error))) {
    out = await callGemini(parts); // model without imageConfig support: aspect is also stated in the prompt
  }
  return json(out, "error" in out ? 502 : 200, h);
});
