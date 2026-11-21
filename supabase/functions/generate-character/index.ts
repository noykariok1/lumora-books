// Sefer VaChetzi (ספר וחצי): likeness-preserving character + page illustration via Google Gemini image model.
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   GEMINI_API_KEY      required
//   GEMINI_IMAGE_MODEL  optional, default "gemini-3-pro-image" (Nano Banana Pro, best identity consistency; cheaper: gemini-nano-banana-2.1)
//   ALLOWED_ORIGINS     optional, comma separated, e.g. "https://lumora.onrender.com,http://localhost:8080"
// Request (POST JSON):
//   extra?: ["<base64>", ...] up to 2 more photos of the child (render mode)
//   size?: "1K"|"2K" on any mode with an aspect (2K is used for printed pages)
//   style?: "cinema3d"|"gouache", book?: <book id>, slot?: "cover"|"page"|"hero"|"sheet"  (render/swap: house art direction, v7)
//   { mode: "swap", photo, extra?: [..], hero: "<base64 approved hero>", face?: "<base64 4-angle head sheet>", base: "<base64 finished page>", heroMime?, faceMime?, baseMime?, aspect?, prompt? }
//   { mode: "check", hero, face?, page, *Mime? } -> { score: 0..10, found, issues }  (v11 likeness check, text model, no photo needed)
//   slot "face" on render: 4-angle head identity sheet of the hero (v11)
//   render slot "hero"/"face" with a style: a vision model first writes a likeness checklist from the photos (v14; describe:false skips it)
//   v15: render hero/face accepts prev (+prevMime) = earlier drawing to correct with the parent's fix; render/swap accept refIsArt:true when image 1 is a saved illustrated character, not a photo
//   v16: engine?: "gemini"|"gpt" (default: secret IMAGE_ENGINE, else "gemini"); quality?: "low"|"medium"|"high" (gpt only, default high).
//        "gpt" = OpenAI gpt-image-2 via /v1/images/edits (needs secret OPENAI_API_KEY; OPENAI_IMAGE_MODEL optional). If gpt fails, falls back to Gemini.
//        Response also carries engine: "gpt"|"gemini".
//   v23: likeness checklist also for family members (person); stylize 3 = clearly animated (noy: hero looked like a photo).
//   v22: swap with cast keeps all outfits from the base page and must replace every family placeholder.
//   v21 (family series): render accepts person?: "father"|"mother"|"brother"|"sister"|"grandfather"|"grandmother" when image 1 is a photo of a family member
//        (draws that person's character instead of the child's), and render/swap accept cast?: [{ role, hero, heroMime? }] (up to 3) =
//        approved characters of the other family members who appear on the page.
//   { mode: "character", photo: "<base64 jpeg>", gender: "m"|"f", traits?: {...}, notes?: string, variant?: 0..3 }
//   { mode: "page", photo: "<base64>", sheet: "<base64 approved character>", scene: "text", gender, variant?: number }
// Response: { image: "<base64 png/jpeg>", mime: "image/png" } or { error, code }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") || "gemini-3-pro-image";
const KEY = Deno.env.get("GEMINI_API_KEY") || "";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_B64 = 6_000_000; // ~4.5 MB per image
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("OPEN_API_KEY") || ""; // the key was saved as OPEN_API_KEY on 2026-11-21
const OPENAI_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-2";
const DEFAULT_ENGINE = Deno.env.get("IMAGE_ENGINE") || "gemini";

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

// ---- v21: family members (cast) ----
const ROLE_EN: Record<string, string> = { father: "father", mother: "mother", brother: "brother", sister: "sister", grandfather: "grandfather", grandmother: "grandmother" };
const ROLE_NOTE: Record<string, string> = {
  father: "an adult man, the child's father", mother: "an adult woman, the child's mother",
  brother: "a child, the hero's brother", sister: "a child, the hero's sister",
  grandfather: "an older man, the child's grandfather", grandmother: "an older woman, the child's grandmother",
};
const personOf = (body: Record<string, unknown>) => ROLE_EN[String(body.person || "")] || "";
function castOf(body: Record<string, unknown>) {
  return (Array.isArray(body.cast) ? body.cast : []).slice(0, 3).map((c) => c as Record<string, unknown>)
    .filter((c) => ROLE_EN[String(c.role)] && typeof c.hero === "string" && c.hero.length > 0 && String(c.hero).length <= MAX_B64)
    .map((c) => ({ role: ROLE_EN[String(c.role)], hero: String(c.hero), mime: /^image\/(png|jpeg|webp)$/.test(String(c.heroMime)) ? String(c.heroMime) : "image/jpeg" }));
}
const PLACEHOLDER: Record<string, string> = {
  grandfather: "the grandfather placeholder is an older man with short grey hair and round glasses",
  grandmother: "the grandmother placeholder is an older woman with chin-length silver hair",
  father: "the father placeholder is the adult man", mother: "the mother placeholder is the adult woman",
  brother: "the brother placeholder is the other boy", sister: "the sister placeholder is the other girl",
};
function castText(cast: { role: string }[], first: number, swap: boolean) {
  if (!cast.length) return "";
  const list = cast.map((c, k) => `image ${first + k} is the approved illustrated character of the hero's ${c.role} (${ROLE_NOTE[c.role]})`).join("; ");
  return `\nFAMILY CAST: ${list}. ${swap
    ? `The page contains PLACEHOLDER family members (${cast.map((c) => PLACEHOLDER[c.role] || c.role).join("; ")}). EVERY one of them that appears MUST be replaced: none of the placeholders' faces, hair, glasses or facial hair may remain anywhere in the result, even if the person is small, in the background or turned away. Replace each placeholder's identity (face, skin tone, hair colour and style, baldness, glasses or no glasses, facial hair or none, build) with the matching approved character, keeping the placeholder's pose, position, size and expression. Each family member must look exactly like their approved character, the same on every page.`
    : `Whenever the scene has the ${cast.map((c) => c.role).join(" or ")}, draw them exactly like their approved character (face, skin tone, hair, glasses, facial hair, build), the same on every page.`} Keep the cast images only for identity, never for style. Do not add a family member who is not in the scene.`;
}

// ---- Art direction (v7): one house look for every book, chosen with `style` on render/swap requests ----
// The scene text that comes from the book data may still mention the old gouache look; the house style below wins.
const ART: Record<string, string> = {
  cinema3d: `HOUSE STYLE (overrides any style words in the scene text): a still frame from a premium 3D animated feature film.
Stylized, appealing characters (not photoreal, not plastic): soft subsurface-scattering skin with natural rosy cheeks, large expressive eyes that keep the child's real eye shape and colour,
hair modelled as soft groomed strands with gentle specular highlights, fabrics with visible weave and stitching, believable materials (wood grain, grass blades, metal, glass).
Cinematic lighting: warm key light, soft bounce fill, a clear rim light that separates the hero from the background, light rays and gentle atmospheric depth, shallow depth of field so the background is softly out of focus.
A rich, lived-in, detailed world with storytelling props and depth through layered planes; vary the framing from page to page and never repeat the same frame of plants or objects around the edges. Harmonious saturated colours, never neon, clean natural skin tones.
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
  judo_champion: "World: a warm, friendly judo dojo with light wood walls, tall windows and soft green tatami, later a big bright national-championship sports hall with blue and yellow mats and spotlights; warm golden light, glowing dust in the air, white, sunny yellow, mat green and deep blue accents, sporty but gentle, nobody ever gets hurt.",
  space_captain: "World: a cosy, wondrous outer space; deep indigo and teal nebulae, sparkling stars, cyan light from friendly instruments, warm light on the hero's face, awe and curiosity, never scary.",
};

const COMPOSE: Record<string, string> = {
  cover: `COMPOSITION (book cover, portrait 4:5): one iconic, instantly readable image that works as a small thumbnail.
The hero stands or moves in the LOWER 62% of the frame, three-quarter view toward the viewer, face lit and the brightest point of the image, a confident joyful expression.
The TOP 35% of the frame is calm, simple background only (sky, space, soft foliage or light) with no faces, no characters and no important detail: a title will be printed there.
Keep the bottom 6% free of important detail. Depth in three layers: a foreground element, the hero, then the world behind.`,
  page: `COMPOSITION (picture-book page, portrait 4:5): choose the camera the moment needs (wide establishing shot, high or low angle, side tracking shot, medium two-shot or close-up) and show the ACTION of the scene, not a standing pose; the hero must be doing what the scene says.
The hero's face is always visible, lit and in focus, never hidden, cropped or turned away. Clear staging: the action of the scene reads in one second.
Keep one calm, uncluttered area of the image. Keep every page of the book in the same style, outfit, palette and character design.`,
  hero: `COMPOSITION: character model of the hero alone, full body, front three-quarter view, relaxed happy pose, on a plain soft light-cream seamless studio background with only a soft floor shadow: no scenery, no flowers, no props, nothing else in the image.`,
  face: `COMPOSITION (identity sheet of the hero's HEAD ONLY, 16:9): the same child's head and shoulders drawn 4 times side by side at large size, evenly lit, on a plain soft light-cream background: 1) straight front view, neutral friendly face, 2) three-quarter view turned left, 3) three-quarter view turned right, 4) front view with a big open-mouth laugh. Identical face, hair, skin tone and age in all 4. No body below the shoulders, no props, no text, no other characters.`,
  sheet: `COMPOSITION (character reference sheet, 16:9): every character of the book side by side on a plain soft light-cream background, full body, evenly lit, same scale, plus the key props, so later pages can match them exactly.`,
};

function artDirection(body: Record<string, unknown>) {
  const style = ART[String(body.style || "")];
  if (!style) return "";
  const slot = String(body.slot || "page");
  // character models stay on a plain background: the book's world is only for covers and pages
  const world = slot === "hero" || slot === "sheet" || slot === "face" ? "" : WORLD[String(body.book || "")] || "";
  return [style, world, COMPOSE[slot] || COMPOSE.page].filter(Boolean).join("\n");
}

// The book data still carries old 2D style words ("gouache", "watercolour"): for character models the house style must win,
// otherwise the hero comes out 2D while the pages are 3D, and every page re-interprets the face differently.
function finalLock(body: Record<string, unknown>) {
  const slot = String(body.slot || "");
  if (!ART[String(body.style || "")] || !["hero", "face", "sheet"].includes(slot)) return "";
  return `\nFINAL RULES (these win over anything above): render ONLY in the HOUSE STYLE above${body.style === "cinema3d" ? " (a 3D animated feature-film character render, never a flat 2D drawing, gouache or watercolour)" : ""}.
The output is a clean new image on a plain light-cream background: never paste, trace, blend or overlay the reference photo or any part of it, no photo background, no ghosted faces.
The face must still be unmistakably this real ${personOf(body) || "child"}: same face shape, eyes, nose, mouth, teeth, skin tone, freckles, hair colour, length and texture, glasses${personOf(body) ? ", facial hair, wrinkles and real age" : ""}.`;
}

// v20: optional `stylize` (1 or 2) nudges the hero a little further from a photo toward an animated-film character (noy, 2026-11-21)
function stylizeNote(body: Record<string, unknown>) {
  const lv = Number(body.stylize || 0);
  if (!(lv > 0)) return "";
  const amt = lv >= 3 ? "clearly (about 50%): it must read at first glance as an animated-film character, never as a photo or a realistic render of a real child" : lv >= 2 ? "noticeably (about 30%)" : "slightly (about 15%)";
  return `\nSTYLIZATION: make the hero ${amt} more stylized than a photo, like a lead character of a premium 3D animated feature film: a touch larger, brighter eyes, softer rounder cheeks and chin, smoother simplified skin without pores or photographic detail, hair as soft sculpted strand groups, gentle appealing proportions. It must NOT look like a photograph or a photoreal render. Likeness still comes first: keep this ${personOf(body) || "child"}'s own face shape, eye shape and colour, nose, mouth, teeth, skin tone, hair colour, length and texture, so a parent instantly recognises the child.`;
}

// ---- likeness check (v11): a cheap vision model compares the hero on a finished page with the approved character ----
const CHECK_MODEL = Deno.env.get("GEMINI_CHECK_MODEL") || "gemini-3.8-flash";
async function checkLikeness(refs: { mime: string; data: string }[], page: { mime: string; data: string }) {
  const parts = [
    ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data } })),
    { inline_data: { mime_type: page.mime, data: page.data } },
    { text: `The first ${refs.length} image(s) show the approved illustrated hero of a children's book (the reference). The LAST image is a finished book page.
Find the main hero child on the last image and judge whether it is clearly the SAME character as the reference: face shape, eyes, eyebrows, nose, mouth, skin tone, hair colour, hair length, hair style/texture, glasses or marks, apparent age and body size (a young child, not adult-sized).
Ignore pose, camera, expression, lighting and outfit differences that the scene requires.
Return JSON only: {"score": <0-10, 10 = unmistakably the same child>, "found": <true if the hero child is visible>, "issues": "<short English list of concrete differences, empty if none>"}` },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data?.error?.message || `Gemini HTTP ${res.status}`, code: res.status === 429 ? "rate_limited" : "provider_error" };
  const txt = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  try {
    const j = JSON.parse(txt.replace(/^```json|```$/g, "").trim());
    return { score: Math.max(0, Math.min(10, Number(j.score) || 0)), found: j.found !== false, issues: String(j.issues || "").slice(0, 400) };
  } catch { return { error: "Bad check reply", code: "empty" }; }
}

// ---- likeness notes (v14): a cheap vision model writes a precise feature list from the photos, so the hero is drawn from facts, not a vague impression ----
async function describeChild(photos: string[], person = "") {
  const parts = [
    ...photos.map((d) => ({ inline_data: { mime_type: "image/jpeg", data: d } })),
    { text: `These photos all show the same real ${person || "child"}. Write a precise LIKENESS CHECKLIST an illustrator can follow, in English, one short line each:
face shape and chin; cheeks; eye shape, size relative to the face, spacing and colour; eyebrows (shape, thickness, colour); nose; mouth, lips and teeth; ears; skin tone (describe it exactly, e.g. "light olive", "medium brown"); hair colour, length, texture and exactly how it is worn (fringe or not, parting, ponytail, braid, curls); glasses, freckles, moles or marks; apparent age and build; typical expression.
Only facts visible in the photos. No names, no guesses about ethnicity.${person ? " Also: apparent age, face width and fullness, wrinkles and skin texture, hair colour, length and parting exactly (e.g. shoulder-length white-grey hair swept to one side), jewellery." : ""} Plain text, max 14 lines.` },
  ];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0 } }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("").trim().slice(0, 1500);
  } catch { return ""; }
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

// v16: OpenAI image edits. parts = Gemini-style [{inline_data:{mime_type,data}}..., {text}] so both engines share one prompt builder.
const GPT_SIZES: Record<string, string[]> = {
  "4:5": ["1024x1280", "1024x1536"], "16:9": ["1536x864", "1536x1024"], "3:2": ["1536x1024"], "1:1": ["1024x1024"],
};
const GPT_SIZES_2K: Record<string, string[]> = {
  "4:5": ["1600x2000", "1024x1280", "1024x1536"], "16:9": ["2048x1152", "1536x864", "1536x1024"], "3:2": ["1536x1024"], "1:1": ["2048x2048", "1024x1024"],
};
function b64ToBlob(data: string, mime: string) {
  const bin = atob(data); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
async function callOpenAI(parts: unknown[], aspect?: string, size?: string, quality = "high") {
  if (!OPENAI_KEY) return { error: "OPENAI_API_KEY is not set", code: "not_configured" };
  const imgs: { mime: string; data: string }[] = [];
  let text = "";
  for (const p of parts as Record<string, any>[]) {
    const d = p.inline_data || p.inlineData;
    if (d?.data) imgs.push({ mime: d.mime_type || d.mimeType || "image/jpeg", data: d.data });
    else if (p.text) text += (text ? "\n" : "") + p.text;
  }
  if (!imgs.length) return { error: "No reference image", code: "provider_error" };
  const sizes = [...((size === "2K" ? GPT_SIZES_2K : GPT_SIZES)[aspect || "1:1"] || ["auto"]), "auto"];
  let last: { error: string; code: string } = { error: "OpenAI failed", code: "provider_error" };
  let fidelity = true;
  for (let i = 0; i < sizes.length; i++) {
    const fd = new FormData();
    fd.append("model", OPENAI_MODEL);
    fd.append("prompt", text.slice(0, 32000));
    fd.append("size", sizes[i]);
    fd.append("quality", ["low", "medium", "high"].includes(quality) ? quality : "high");
    fd.append("output_format", "jpeg");
    fd.append("n", "1");
    if (fidelity) fd.append("input_fidelity", "high");
    imgs.slice(0, 16).forEach((im, k) => fd.append("image[]", b64ToBlob(im.data, im.mime), `ref${k + 1}.${im.mime.includes("png") ? "png" : im.mime.includes("webp") ? "webp" : "jpg"}`));
    const res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.data?.[0]?.b64_json) return { image: data.data[0].b64_json, mime: "image/jpeg" };
    const msg = String(data?.error?.message || `OpenAI HTTP ${res.status}`);
    last = { error: msg, code: res.status === 429 ? "rate_limited" : /safety|moderation/i.test(msg) ? "blocked" : "provider_error" };
    if (res.status === 400 && /input_fidelity/i.test(msg) && fidelity) { fidelity = false; i--; continue; }
    if (!(res.status === 400 && /size/i.test(msg))) break; // only retry on an unsupported size
  }
  return last;
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
  if (!KEY && !OPENAI_KEY) return json({ error: "No image API key is set", code: "not_configured" }, 500, h);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) return json({ error: "Too many requests, try again in a few minutes", code: "rate_limited" }, 429, h);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400, h); }
  const mt = (m: unknown) => /^image\/(png|jpeg|webp)$/.test(String(m)) ? String(m) : "image/jpeg";
  if (body.mode === "check") {
    // { mode:"check", hero, heroMime?, face?, faceMime?, page, pageMime? } -> { score, found, issues }
    const hero = String(body.hero || ""), page = String(body.page || ""), face = String(body.face || "");
    if (!hero || !page || [hero, page, face].some((x) => x.length > MAX_B64)) return json({ error: "Missing hero or page" }, 400, h);
    const refs = [{ mime: mt(body.heroMime), data: hero }, ...(face ? [{ mime: mt(body.faceMime), data: face }] : [])];
    const r = await checkLikeness(refs, { mime: mt(body.pageMime), data: page });
    return json(r, "error" in r ? 502 : 200, h);
  }
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
    // v15: refIsArt = image 1 is the child's saved illustrated character (reused in a new book), not a photo
    const refIsArt = body.refIsArt === true;
    const person = personOf(body);
    const who = person ? (nP === 1 ? `Image 1 is the photo of ${ROLE_NOTE[person]} (NOT the hero child). Draw this real person, keeping their real age.` : `Images 1 to ${nP} are photos of ${ROLE_NOTE[person]} (NOT the hero child). Draw this real person, keeping their real age.`)
      : refIsArt ? "Image 1 is the approved illustrated character of the real child, the hero (no photo available): keep this exact face, hair, skin tone and proportions."
      : nP === 1 ? "Image 1 is the photo (or chosen avatar) of the real child, the hero."
      : `Images 1 to ${nP} are photos of the same real child, the hero, from different moments and angles; use all of them together to get the face exactly right (image 1 is the main one).`;
    // v15: prev = the earlier hero drawing the parent asked to correct; keep it and change only what was asked
    const prev = ["hero", "face"].includes(String(body.slot)) && !sheet ? String(body.prev || "") : "";
    const iPrev = nP + 1;
    const intro = sheet
      ? `${who} Image ${nP + 1} is the approved character reference sheet for this book: keep every character, outfit, prop, colour and proportion exactly as in image ${nP + 1}, and the hero's face exactly as in the ${refIsArt ? "character" : "photo(s)"}.`
      : prev && prev.length <= MAX_B64
      ? `${who} Image ${iPrev} is our earlier drawing of this child. The parent asked for a correction (below): keep image ${iPrev}'s character design, rendering, outfit and everything that is already right, change ONLY what the correction asks, and use the photo(s) to get those features right.`
      : who;
    // hero/face character models: describe the child first (skipped when the client says photo is not a real child)
    const notes = ART[String(body.style || "")] && ["hero", "face"].includes(String(body.slot)) && (body.describe !== false || person) && !refIsArt ? await describeChild([photo, ...extra], person) : "";
    const rCast = person ? [] : castOf(body);
    const iCast = nP + 1 + (sheet ? 1 : 0) + (prev && prev.length <= MAX_B64 ? 1 : 0);
    parts = [
      { inline_data: { mime_type: "image/jpeg", data: photo } },
      ...extra.map((d) => ({ inline_data: { mime_type: "image/jpeg", data: d } })),
      ...(sheet ? [{ inline_data: { mime_type: /^image\/(png|jpeg|webp)$/.test(String(body.sheetMime)) ? String(body.sheetMime) : "image/png", data: sheet } }] : []),
      ...(prev && prev.length <= MAX_B64 ? [{ inline_data: { mime_type: mt(body.prevMime), data: prev } }] : []),
      ...rCast.map((c) => ({ inline_data: { mime_type: c.mime, data: c.hero } })),
      { text: `${intro}${castText(rCast, iCast, false)}\n${artDirection(body)}\n${person ? RENDER_RULES.replace(/\bchild\b/g, "person") : RENDER_RULES}\n${prompt}${notes ? (person ? `\nLIKENESS CHECKLIST for this specific person (read from the photos; follow it exactly: face shape and fullness, hair length, colour and parting, skin tone and real age must match, never a generic grandparent):\n${notes}` : `\nLIKENESS CHECKLIST for this specific child (read from the photos; follow it exactly, and keep a real child's face proportions: no oversized round cartoon head, no huge baby eyes):\n${notes}`) : ""}${finalLock(body)}${stylizeNote(body)}` },
    ];
  } else if (body.mode === "swap") {
    // pre-illustrated book page: photo(s) of the child, approved hero character, optional face identity sheet, finished page with a placeholder hero
    const hero = String(body.hero || ""), base = String(body.base || ""), face = String(body.face || "");
    if (!hero || !base || hero.length > MAX_B64 || base.length > MAX_B64 || face.length > MAX_B64) return json({ error: "Missing hero or base page" }, 400, h);
    const extra = String(body.prompt || "").slice(0, 800);
    const photos = [photo, ...(Array.isArray(body.extra) ? body.extra : []).map(String).filter((x) => x && x.length <= MAX_B64).slice(0, 2)];
    aspect = ["4:5", "16:9", "3:2", "1:1"].includes(String(body.aspect)) ? String(body.aspect) : "4:5";
    const nP = photos.length, iHero = nP + 1, iFace = face ? nP + 2 : 0, iBase = nP + (face ? 3 : 2);
    const sCast = castOf(body);
    const who = body.refIsArt === true ? "Image 1 is the child's saved illustrated character (no photo available)." : nP === 1 ? "Image 1 is a photo (or avatar) of the real child." : `Images 1 to ${nP} are photos of the same real child.`;
    parts = [
      ...photos.map((d) => ({ inline_data: { mime_type: "image/jpeg", data: d } })),
      { inline_data: { mime_type: mt(body.heroMime), data: hero } },
      ...(face ? [{ inline_data: { mime_type: mt(body.faceMime), data: face } }] : []),
      { inline_data: { mime_type: mt(body.baseMime), data: base } },
      ...sCast.map((c) => ({ inline_data: { mime_type: c.mime, data: c.hero } })),
      { text: `${who} Image ${iHero} is this child's approved illustrated character${face ? `, and image ${iFace} is the same character's head from 4 angles (identity sheet)` : ""}. Image ${iBase} is a finished children's-book illustration whose main hero is a PLACEHOLDER child.
Redraw image ${iBase} EXACTLY: same composition, camera, background, lighting, colours, rendering style, other characters, props, and the hero's pose, position and outfit. Keep the hero's facial expression, emotion, gaze direction and head turn exactly as in image ${iBase}: do not make the hero look at the camera or smile unless the placeholder does.
Replace the placeholder hero's identity with the approved character of image ${iHero}${face ? ` and ${iFace}` : ""}: face shape, eyes, eyebrows, nose, mouth, skin tone, hair colour, hair length, hair style and texture, glasses and marks must be IDENTICAL to the approved character, so the child looks exactly the same on every page of the book. Pick the angle from the identity sheet that matches the hero's head turn. The placeholder's face and hair must not remain anywhere; a parent must recognise their child at once.
SIZE IS FIXED: the hero keeps EXACTLY the placeholder's height, head size, body size and body proportions in the frame, with the top of the head in the same place. The hero is a young child: never taller or bigger than in image ${iBase}, never adult-sized, the same height as the other children in the picture.
STYLE IS FIXED: render the hero in exactly the same style, lighting, materials and detail as image ${iBase}. Use the other images only for who the child is (identity), never for drawing style, outfit, size or proportions.${castText(sCast, iBase + 1, true)}${sCast.length ? `\nOUTFITS ARE FIXED: every person, the hero included, keeps EXACTLY the clothes, shoes and colours they wear in image ${iBase}. The reference characters may wear different clothes: ignore their clothes completely and take only identity (face, skin, hair, glasses, facial hair, body build) from them.` : ""}
${RENDER_RULES}
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
  const engine = (body.engine === "gpt" || body.engine === "gemini") ? String(body.engine) : DEFAULT_ENGINE;
  if (engine === "gpt" && OPENAI_KEY) {
    const g = await callOpenAI(parts, aspect, size, String(body.quality || "high"));
    if (!("error" in g)) return json({ ...g, engine: "gpt" }, 200, h);
    if (!KEY || body.fallback === false) return json({ ...g, engine: "gpt" }, 502, h);
    console.log("gpt failed, falling back to gemini:", g.code, String(g.error).slice(0, 200));
  }
  if (!KEY) return json({ error: "GEMINI_API_KEY is not set", code: "not_configured" }, 500, h);
  let out = await callGemini(parts, aspect, size);
  if ("error" in out && size && out.code === "provider_error" && /imageSize|size/i.test(String(out.error))) out = await callGemini(parts, aspect);
  if ("error" in out && aspect && out.code === "provider_error" && /aspect|imageConfig|Unknown name/i.test(String(out.error))) {
    out = await callGemini(parts); // model without imageConfig support: aspect is also stated in the prompt
  }
  return json({ ...out, engine: "gemini" }, "error" in out ? 502 : 200, h);
});
