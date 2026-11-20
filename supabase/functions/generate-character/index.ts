// Lumora: likeness-preserving character + page illustration via Google Gemini image model.
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   GEMINI_API_KEY      required
//   GEMINI_IMAGE_MODEL  optional, default "gemini-3-pro-image" (Nano Banana Pro, best identity consistency; cheaper: gemini-nano-banana-2.1)
//   ALLOWED_ORIGINS     optional, comma separated, e.g. "https://lumora.onrender.com,http://localhost:8080"
// Request (POST JSON):
//   extra?: ["<base64>", ...] up to 2 more photos of the child (render mode)
//   size?: "1K"|"2K" on any mode with an aspect (2K is used for printed pages)
//   style?: "cinema3d"|"gouache", book?: <book id>, slot?: "cover"|"page"|"hero"|"sheet"  (render/swap: house art direction, v7)
//   { mode: "swap", photo, hero: "<base64 approved hero>", base: "<base64 finished page>", heroMime?, baseMime?, aspect?, prompt? }
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
function limited(ip: string, max = 90, windowMs = 10 * 60_000) {
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

// ---- Art direction (v7): one house look for every book, chosen with `style` on render/swap requests ----
// The scene text that comes from the book data may still mention the old gouache look; the house style below wins.
const ART: Record<string, string> = {
  cinema3d: `HOUSE STYLE (overrides any style words in the scene text): a still frame from a premium 3D animated feature film.
Stylized, appealing characters (not photoreal, not plastic): soft subsurface-scattering skin with natural rosy cheeks, large expressive eyes that keep the child's real eye shape and colour,
hair modelled as soft groomed strands with gentle specular highlights, fabrics with visible weave and stitching, believable materials (wood grain, grass blades, metal, glass).
Cinematic lighting: warm key light, soft bounce fill, a clear rim light that separates the hero from the background, light rays and gentle atmospheric depth, shallow depth of field so the background is softly out of focus.
A rich, lived-in, detailed world with storytelling props and a foreground framing element for depth. Harmonious saturated colours, never neon, clean natural skin tones.
Faces read clearly with one strong emotion. Correct anatomy: five fingers per hand, no extra limbs, both eyes looking the same way. Crisp, clean, high detail, no artefacts, no blur on the hero's face.`,
  gouache: `HOUSE STYLE (overrides any style words in the scene text): a premium hand-painted picture-book illustration in gouache and coloured pencil, visible paper grain and brush texture,
rich layered detail in the background, soft directional light with warm highlights and cool shadows, rounded friendly shapes, slightly larger head and eyes than real proportions but clearly the same child.
Harmonious palette, clean skin tones, clear emotion, correct anatomy, crisp clean edges.`,
};

// Each book has its own world and light, so the four books look like one family but never the same.
const WORLD: Record<string, string> = {
  soccer_hero: "World: a friendly neighbourhood football pitch at late-afternoon golden hour; long soft shadows, glowing dust in the air, turquoise, sunny yellow, grass green and coral accents.",
  little_firefighter: "World: a cheerful, safe neighbourhood fire station on a bright morning; sunlight through big bay doors, polished brass and red paint, warm amber light, nothing frightening, any fire is tiny and under control.",
  fairy_garden: "World: an enchanted garden seen at fairy scale on a dewy morning; flowers bigger than the child, glowing pollen, soft bokeh, lilac, blush pink, mint and butter yellow, magical but gentle.",
  space_captain: "World: a cosy, wondrous outer space; deep indigo and teal nebulae, sparkling stars, cyan light from friendly instruments, warm light on the hero's face, awe and curiosity, never scary.",
};

const COMPOSE: Record<string, string> = {
  cover: `COMPOSITION (book cover, portrait 4:5): one iconic, instantly readable image that works as a small thumbnail.
The hero stands or moves in the LOWER 62% of the frame, three-quarter view toward the viewer, face lit and the brightest point of the image, a confident joyful expression.
The TOP 35% of the frame is calm, simple background only (sky, space, soft foliage or light) with no faces, no characters and no important detail: a title will be printed there.
Keep the bottom 6% free of important detail. Depth in three layers: a foreground element, the hero, then the world behind.`,
  page: `COMPOSITION (picture-book page, portrait 4:5): choose the camera the moment needs (wide establishing shot, medium shot or close-up), eye level with the child.
The hero's face is always visible, lit and in focus, never hidden, cropped or turned away. Clear staging: the action of the scene reads in one second.
Keep one calm, uncluttered area of the image. Keep every page of the book in the same style, outfit, palette and character design.`,
  hero: `COMPOSITION: character model of the hero alone, full body, front three-quarter view, relaxed happy pose, on a plain soft light-cream seamless background with a soft floor shadow.`,
  sheet: `COMPOSITION (character reference sheet, 16:9): every character of the book side by side on a plain soft light-cream background, full body, evenly lit, same scale, plus the key props, so later pages can match them exactly.`,
};

function artDirection(body: Record<string, unknown>) {
  const style = ART[String(body.style || "")];
  if (!style) return "";
  return [style, WORLD[String(body.book || "")] || "", COMPOSE[String(body.slot || "page")] || COMPOSE.page].filter(Boolean).join("\n");
}

async function callGemini(parts: unknown[], aspect?: string, size?: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: aspect
        ? { responseModalities: ["IMAGE", "TEXT"], imageConfig: size ? { aspectRatio: aspect, imageSize: size } : { aspectRatio: aspect } }
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
    const prompt = String(body.prompt || "").slice(0, 4000);
    if (!prompt) return json({ error: "Missing prompt" }, 400, h);
    aspect = ["4:5", "16:9", "3:2", "1:1"].includes(String(body.aspect)) ? String(body.aspect) : "4:5";
    // optional extra photos of the same child (other angles / smile) for a stronger identity lock
    const extra = (Array.isArray(body.extra) ? body.extra : []).map(String).filter((x) => x && x.length <= MAX_B64).slice(0, 2);
    const nP = 1 + extra.length;
    const who = nP === 1 ? "Image 1 is the photo (or chosen avatar) of the real child, the hero."
      : `Images 1 to ${nP} are photos of the same real child, the hero, from different moments and angles; use all of them together to get the face exactly right (image 1 is the main one).`;
    const intro = sheet
      ? `${who} Image ${nP + 1} is the approved character reference sheet for this book: keep every character, outfit, prop, colour and proportion exactly as in image ${nP + 1}, and the hero's face exactly as in the photo(s).`
      : who;
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      ...extra.map((d) => ({ inline_data: { mime_type: "image/jpeg", data: d } })),
      ...(sheet ? [{ inline_data: { mime_type: /^image\/(png|jpeg|webp)$/.test(String(body.sheetMime)) ? String(body.sheetMime) : "image/png", data: sheet } }] : []),
      { text: `${intro}\n${artDirection(body)}\n${RENDER_RULES}\n${prompt}` },
    ];
  } else if (body.mode === "swap") {
    // pre-illustrated book page: image 1 = child photo/avatar, image 2 = approved hero character, image 3 = finished page with a placeholder hero
    const hero = String(body.hero || ""), base = String(body.base || "");
    if (!hero || !base || hero.length > MAX_B64 || base.length > MAX_B64) return json({ error: "Missing hero or base page" }, 400, h);
    const extra = String(body.prompt || "").slice(0, 800);
    aspect = ["4:5", "16:9", "3:2", "1:1"].includes(String(body.aspect)) ? String(body.aspect) : "4:5";
    const mt = (m: unknown) => /^image\/(png|jpeg|webp)$/.test(String(m)) ? String(m) : "image/jpeg";
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      { inline_data: { mime_type: mt(body.heroMime), data: hero } },
      { inline_data: { mime_type: mt(body.baseMime), data: base } },
      { text: `Image 1 is a photo (or avatar) of the real child. Image 2 is this child's approved illustrated character. Image 3 is a finished children's-book illustration.
Redraw image 3 EXACTLY: same composition, camera, background, lighting, colours, style, other characters, props and the hero's pose, position, size and outfit.
Change ONLY the main hero child's face, skin tone, hair and body proportions so that the hero becomes the child of image 2 (with the face of image 1).
${RENDER_RULES}
${body.style ? "Keep the rendering style of image 3 exactly (lighting, materials, detail); the new face must be rendered in that same style." : ""}
${extra}` },
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
  const size = ["1K", "2K"].includes(String(body.size)) ? String(body.size) : undefined; // 2K for print pages
  let out = await callGemini(parts, aspect, size);
  if ("error" in out && size && out.code === "provider_error" && /imageSize|size/i.test(String(out.error))) out = await callGemini(parts, aspect);
  if ("error" in out && aspect && out.code === "provider_error" && /aspect|imageConfig|Unknown name/i.test(String(out.error))) {
    out = await callGemini(parts); // model without imageConfig support: aspect is also stated in the prompt
  }
  return json(out, "error" in out ? 502 : 200, h);
});
