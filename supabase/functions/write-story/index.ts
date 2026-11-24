// Agadibook "סיפור משלכם": writes an original Hebrew picture-book story from a parent's idea, then adds full nikud.
// Secrets: OPENAI_API_KEY (or OPEN_API_KEY), GEMINI_API_KEY (fallback). Optional: STORY_MODEL, NIKUD_MODEL, GEMINI_TEXT_MODEL.
// The child's real name is never sent to the model: the hero is always the placeholder {{childName}}.
// Requests (POST JSON):
//   { action:"write", idea, age:"0-2"|"3-5"|"6-8", tone, gender:"m"|"f", details?, lesson? }
//      -> { ok:true, story:{ title, refrain, summary, world, heroOutfit, characters[], props[], coverScene, pages:[{text,scene,cast[]}] }, usage }
//      -> { ok:false, code:"unsuitable", reason }   (idea not fit for a children's book)
//   { action:"nikud", texts:[string], gender }  -> { texts:[string|null] }  (null = could not add nikud safely; show plain text)
//   { action:"revise", story, index, request, gender, age } -> { text, scene }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("OPEN_API_KEY") || "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const STORY_MODEL = Deno.env.get("STORY_MODEL") || "gpt-5.5";
const NIKUD_MODEL = Deno.env.get("NIKUD_MODEL") || "gpt-5.5";
const NIKUD_ENGINE = Deno.env.get("NIKUD_ENGINE") || "gemini"; // gemini-3.1-pro was faster and more accurate on our test pages (2026-11-21)
const GEMINI_TEXT = Deno.env.get("GEMINI_TEXT_MODEL") || "gemini-3.1-pro-preview";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim()).filter(Boolean);
const PAGES = 12;

const hits = new Map<string, number[]>();
function limited(ip: string, max = 40, windowMs = 10 * 60_000) {
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
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);

// ---------- model calls ----------
type Usage = { input: number; output: number; model: string };
type Opts = { model?: string; effort?: string; engine?: string; u: Usage[] };

async function openaiJSON(u: Usage[], model: string, system: string, user: string, schema: Record<string, unknown>, effort = "medium") {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning_effort: effort,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "out", strict: true, schema } },
    }),
    signal: AbortSignal.timeout(170_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d?.error?.message || `OpenAI HTTP ${res.status}`), { code: res.status === 429 ? "rate_limited" : "provider_error" });
  u.push({ input: d?.usage?.prompt_tokens || 0, output: d?.usage?.completion_tokens || 0, model });
  const msg = d?.choices?.[0]?.message;
  if (msg?.refusal) throw Object.assign(new Error(msg.refusal), { code: "blocked" });
  return JSON.parse(msg?.content || "{}");
}

async function geminiJSON(u: Usage[], system: string, user: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(170_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d?.error?.message || `Gemini HTTP ${res.status}`), { code: res.status === 429 ? "rate_limited" : "provider_error" });
  u.push({ input: d?.usageMetadata?.promptTokenCount || 0, output: d?.usageMetadata?.candidatesTokenCount || 0, model: GEMINI_TEXT });
  const t = (d?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  return JSON.parse(t.replace(/^```json\s*|```\s*$/g, ""));
}

// OpenAI first, Gemini if it fails (and the other way round when forced)
async function askJSON(system: string, user: string, schema: Record<string, unknown>, opts: Opts) {
  const tryOpenAI = () => openaiJSON(opts.u, opts.model || STORY_MODEL, system, user, schema, opts.effort);
  const tryGemini = () => geminiJSON(opts.u, system, user + "\n\nReturn ONLY JSON that matches this JSON Schema:\n" + JSON.stringify(schema));
  if (opts.engine === "gemini" && GEMINI_KEY) {
    try { return await tryGemini(); } catch (e) { if (!OPENAI_KEY) throw e; console.log("gemini failed, openai fallback:", String(e).slice(0, 200)); return tryOpenAI(); }
  }
  if (OPENAI_KEY) {
    try { return await tryOpenAI(); } catch (e) {
      if (!GEMINI_KEY || (e as { code?: string }).code === "blocked") throw e;
      console.log("openai failed, gemini fallback:", String(e).slice(0, 200));
    }
  }
  if (!GEMINI_KEY) throw Object.assign(new Error("No text model key"), { code: "not_configured" });
  return tryGemini();
}

// ---------- prompts ----------
const AGE: Record<string, string> = {
  "0-2": "toddlers aged 0-2: very short pages (60 to 120 Hebrew characters), simple concrete words, lots of sound words and repetition, almost no plot tension, a gentle cosy rhythm",
  "3-5": "children aged 3-5: pages of 160 to 260 Hebrew characters, simple vocabulary, short sentences, a clear easy plot, humour and a repeating refrain",
  "6-8": "children aged 6-8: pages of 220 to 320 Hebrew characters, richer vocabulary and dialogue, a real problem with rising tension, clever solutions and humour",
};
const TONE: Record<string, string> = {
  "חם ומצחיק": "warm and funny: playful situations, gentle jokes, a happy glow",
  "הרפתקני ומותח": "adventurous and exciting: momentum, small cliff-hangers between pages, never truly frightening",
  "רגוע לפני השינה": "calm, for bedtime: soft pace, soothing images, the last pages wind down to sleep",
  "מרגש ומעורר השראה": "moving and inspiring: the hero grows, tries again, and earns a proud, emotional ending",
};

function genderRules(g: string) {
  return g === "m"
    ? `The hero is a BOY. Every verb, adjective, pronoun and imperative that refers to the hero is MASCULINE Hebrew (הוא, שלו, אמר, רץ, צחק, שמח, היה עייף, ״בוא!״). Never mix in feminine forms for him.`
    : `The hero is a GIRL. Every verb, adjective, pronoun and imperative that refers to the hero is FEMININE Hebrew (היא, שלה, אמרה, רצה, צחקה, שמחה, הייתה עייפה, ״בואי!״). Never mix in masculine forms for her.`;
}

const WRITER = `You are an award-winning Israeli children's author. You write original, warm, funny, beautifully paced picture books in natural modern Israeli Hebrew (never translated-sounding), like the best books on an Israeli kindergarten shelf.
You are writing a PERSONALISED book: the parent gave the idea, and their own child is the hero.

THE HERO'S NAME: always write it exactly as the placeholder {{childName}}. The real name is inserted later.
- NEVER attach a Hebrew prefix letter to {{childName}}: no ו, ה, ב, כ, ל, מ, ש directly before it. Rephrase instead: "וגם {{childName}}" or "ואז {{childName}}" (not "ו{{childName}}"), "אמרה אל {{childName}}" or "אמרה לו/לה" (not "ל{{childName}}"), "החבר של {{childName}}" (not "ש{{childName}}").
- Use the name about once or twice per page; use pronouns the rest of the time.

LANGUAGE: plain Hebrew letters only, no nikud, full spelling (כתיב מלא) as in modern books. Dialogue in Hebrew quotation marks ״...״. Short, clear sentences a parent enjoys reading aloud, with rhythm and some playful sound words. No slang that will date, no English words.

STORY CRAFT (this is what makes the book great):
- One clear wish or problem for the hero on page 1-2, set in a vivid, specific place.
- Rising action: two or three escalating attempts or discoveries, each on its own page, each a different visual moment and place.
- A low point around page 8-9, then the HERO solves it through their own quality (kindness, courage, curiosity, creativity, persistence). Adults may help but never solve it for them.
- A satisfying, warm ending with a callback to the opening, and a final page that leaves a smile.
- A short catchy refrain (3 to 6 words) that returns 3 or 4 times.
- Concrete sensory details, humour, small surprises, a lovable sidekick if it fits the idea.
- Every page must be easy to illustrate: one main moment with action, and the hero present and visible on EVERY page.
- Respect the parent's details exactly (names of siblings, friends, pets, places). Do not invent other real-world people.
- Safe and kind: no violence, no real danger, nothing scary or sad without comfort, no brands, no famous characters from films, TV, games or books, no religion or politics unless the parent asked for it.

ILLUSTRATION NOTES (English, for the artist; the art style is fixed elsewhere, do not describe a style):
- world: one paragraph describing the setting(s), time of day, light and a colour palette for the whole book.
- heroOutfit: ONE fixed outfit the hero wears on every page (colours, garments, shoes), no text or logos on clothes.
- characters: up to 3 supporting characters (people, animals or creatures) with a short Hebrew name and a precise, fixed visual description (species, age, size, colours, clothes) so they look identical on every page. Use ids like "c1", "c2".
- props: up to 4 recurring objects with fixed looks.
- coverScene: the cover moment, the hero confident and joyful in the lower part of the frame, calm space at the top for the title.
- each page.scene: 1 to 3 sentences: camera (wide, close-up, low angle...), the action, the place, who is there and their emotion. Refer to the hero only as "the hero" (never a name) and to others by their role and look (e.g. "the small orange cat"). No text, signs or letters in the picture.
- each page.cast: ids of supporting characters visible on that page.

If the idea is not suitable for a young children's book at all (sexual content, real violence, hate, real tragedy aimed at the child, private data about other people), set "unsuitable" to a short, kind explanation in Hebrew and return minimal placeholder content. Otherwise "unsuitable" is an empty string.
"summary" is one Hebrew sentence for the parent describing the plot. "title" is a short Hebrew title (2 to 5 words) and may include {{childName}} (again: no attached prefix).`;

const STORY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["unsuitable", "title", "refrain", "summary", "world", "heroOutfit", "characters", "props", "coverScene", "pages"],
  properties: {
    unsuitable: { type: "string" },
    title: { type: "string" },
    refrain: { type: "string" },
    summary: { type: "string" },
    world: { type: "string" },
    heroOutfit: { type: "string" },
    characters: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["id", "name", "role", "appearance"],
        properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, appearance: { type: "string" } },
      },
    },
    props: { type: "array", items: { type: "string" } },
    coverScene: { type: "string" },
    pages: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["text", "scene", "cast"],
        properties: { text: { type: "string" }, scene: { type: "string" }, cast: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const NIKUD_SYS = (g: string) => `You are an expert Hebrew editor of vocalised (מנוקד) children's books in Israel.
Add complete, correct, modern Hebrew nikud (ניקוד מלא) to the text, exactly as a professional children's-book editor would: every letter gets its vowel, dagesh, shin/sin dot, shva and hataf where needed; correct vocalisation of prefixes (וּ before ב/מ/פ and before shva, בַּ/לַ/כַּ with the definite article), construct forms, and verb binyanim.
${g === "m" ? "The hero is a boy: masculine forms." : "The hero is a girl: feminine forms (e.g. אָמְרָה, הִיא, שֶׁלָּהּ with mappiq)."}
STRICT RULES:
- Do NOT change, add, remove or reorder any letter, word, space or punctuation mark. Only add vowel marks. The full spelling stays as is (keep every ו and י, e.g. שַׁרְווּלִים, אִיתָּם).
- Keep the placeholder {{childName}} exactly as written, with no marks inside it.
- Keep the Hebrew quotation marks ״ and the geresh ׳ as they are.
Return JSON {"text": "..."}.`;
const NIKUD_SCHEMA = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };

const MARKS = /[\u0591-\u05BD\u05BF-\u05C7]/g;
const norm = (t: string) => t.replace(MARKS, "").replace(/\s+/g, " ").trim();

// Nikud is matched word by word: a word whose letters changed (e.g. a dropped ו or י) is sent back once on its own.
const WORDS_SCHEMA = { type: "object", additionalProperties: false, required: ["words"], properties: { words: { type: "array", items: { type: "string" } } } };
async function nikudOne(text: string, g: string, o: Opts): Promise<string | null> {
  if (!text.trim()) return text;
  const src = text.replace(/\s+/g, " ").trim().split(" ");
  let best: string[] | null = null;
  for (let attempt = 0; attempt < 2 && !best; attempt++) {
    try {
      const r = await askJSON(NIKUD_SYS(g), (attempt ? "Careful: keep exactly the same words and spelling, only add marks.\n" : "") + text, NIKUD_SCHEMA, { ...o, model: NIKUD_MODEL, effort: "low" });
      const out = String(r?.text || "").replace(/\s+/g, " ").trim().split(" ");
      if (out.length === src.length) best = out;
      else console.log("nikud word count", src.length, out.length);
    } catch (e) { console.log("nikud error", String(e).slice(0, 200)); }
  }
  if (!best) return null;
  const res = src.map((w, i) => norm(best![i]) === w ? best![i] : (/[\u05D0-\u05EA]/.test(w) ? null : w));
  const bad = res.map((w, i) => w === null ? i : -1).filter((i) => i >= 0);
  if (bad.length) {
    console.log("nikud fix words", bad.length, bad.map((i) => src[i] + "→" + norm(best![i])).join(" "));
    try {
      const sys = NIKUD_SYS(g).replace('Return JSON {"text": "..."}.', "") + `\nYou get single words from the sentence below. Return JSON {"words": [...]} with each word vocalised EXACTLY as spelled (same letters, keep every ו and י and the punctuation), in the same order.`;
      const r = await askJSON(sys, `Sentence: ${text}\nWords:\n${bad.map((i) => src[i]).join("\n")}`, WORDS_SCHEMA, { ...o, model: NIKUD_MODEL, effort: "low" });
      const ws: string[] = Array.isArray(r?.words) ? r.words.map(String) : [];
      bad.forEach((i, k) => { if (ws[k] && norm(ws[k]) === src[i]) res[i] = ws[k].trim(); });
    } catch (e) { console.log("nikud word fix error", String(e).slice(0, 200)); }
  }
  const left = res.filter((w) => w === null).length;
  if (left > 2) return null; // too many words without marks: show the page without nikud
  return res.map((w, i) => w ?? src[i]).join(" ");
}

const PREFIXED = /[והבכלמש]\{\{childName\}\}/;
async function fixPrefixes(story: { title: string; pages: { text: string }[] }, g: string, o: Opts) {
  const bad = story.pages.map((p, i) => [i, p.text] as const).filter(([, t]) => PREFIXED.test(t));
  if (PREFIXED.test(story.title)) story.title = story.title.replace(/([והבכלמש])\{\{childName\}\}/g, "{{childName}}");
  if (!bad.length) return;
  const sys = `You fix one rule in Hebrew children's-book text: the placeholder {{childName}} must never have a Hebrew prefix letter (ו ה ב כ ל מ ש) attached directly before it. Rephrase minimally (e.g. "וגם {{childName}}", "אל {{childName}}", "לו"/"לה", "של {{childName}}"). Change nothing else. ${genderRules(g)} Return JSON {"text": "..."}.`;
  await Promise.all(bad.map(async ([i, t]) => {
    try {
      const r = await askJSON(sys, t, NIKUD_SCHEMA, { ...o, effort: "low" });
      if (r?.text && !PREFIXED.test(r.text)) story.pages[i].text = String(r.text);
    } catch (_) { /* keep the original */ }
  }));
}

// ---------- server ----------
Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
  if (!OPENAI_KEY && !GEMINI_KEY) return json({ error: "No text model key", code: "not_configured" }, 500, h);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) return json({ error: "Too many requests", code: "rate_limited" }, 429, h);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400, h); }
  const g = body.gender === "m" ? "m" : "f";
  const engine = body.engine === "gemini" || body.engine === "openai" ? String(body.engine) : undefined; // testing only
  const usage: Usage[] = [];
  const o: Opts = { u: usage, engine };
  const t0 = Date.now();
  try {
    if (body.action === "write") {
      const idea = clip(body.idea, 600);
      if (idea.length < 8) return json({ error: "Missing idea", code: "bad_request" }, 400, h);
      const age = AGE[String(body.age)] ? String(body.age) : "3-5";
      const tone = TONE[String(body.tone)] ? String(body.tone) : "חם ומצחיק";
      const details = clip(body.details, 400), lesson = clip(body.lesson, 160);
      const user = `Write the book now.
Exactly ${PAGES} story pages (plus the cover).
Audience: ${AGE[age]}.
Mood: ${TONE[tone]}.
${genderRules(g)}
The parent's idea (Hebrew, use it faithfully and make it shine): """${idea}"""
${details ? `More details from the parent (people, pets, places, things the child loves): """${details}"""` : ""}
${lesson ? `What the parent hopes the child takes from the story (weave it in gently, never preach): """${lesson}"""` : ""}`;
      const s = await askJSON(WRITER, user, STORY_SCHEMA, { ...o, effort: "medium" });
      if (s?.unsuitable) return json({ ok: false, code: "unsuitable", reason: String(s.unsuitable).slice(0, 300) }, 200, h);
      if (!Array.isArray(s?.pages) || s.pages.length < PAGES) return json({ error: "Story came back incomplete", code: "provider_error" }, 502, h);
      s.pages = s.pages.slice(0, PAGES);
      await fixPrefixes(s, g, o);
      return json({ ok: true, story: s, usage, ms: Date.now() - t0 }, 200, h);
    }
    if (body.action === "nikud") {
      const texts = (Array.isArray(body.texts) ? body.texts : []).slice(0, 20).map((t) => clip(t, 700));
      const out = await Promise.all(texts.map((t) => nikudOne(t, g, { ...o, engine: engine || NIKUD_ENGINE })));
      return json({ texts: out, usage, ms: Date.now() - t0 }, 200, h);
    }
    if (body.action === "revise") {
      const st = body.story as { pages?: { text?: string }[]; title?: string } | undefined;
      const i = Number(body.index) | 0;
      const pages = (st?.pages || []).map((p) => clip(p?.text, 700));
      const request = clip(body.request, 300);
      if (!pages[i] || !request) return json({ error: "Missing page or request", code: "bad_request" }, 400, h);
      const age = AGE[String(body.age)] ? String(body.age) : "3-5";
      const sys = WRITER + `\n\nNow you are revising ONE page of an existing book at the parent's request. Keep the story consistent with the other pages. Return JSON {"text": hebrew page text, "scene": english illustration note for this page}.`;
      const user = `${genderRules(g)}\nAudience: ${AGE[age]}.\nThe whole book (page numbers in brackets):\n${pages.map((t, k) => `[${k + 1}] ${t}`).join("\n")}\n\nRewrite page ${i + 1}. The parent asks (Hebrew): """${request}"""`;
      const r = await askJSON(sys, user, { type: "object", additionalProperties: false, required: ["text", "scene"], properties: { text: { type: "string" }, scene: { type: "string" } } }, { ...o, effort: "low" });
      const fixed = { title: "", pages: [{ text: String(r?.text || "") }] };
      await fixPrefixes(fixed, g, o);
      return json({ text: fixed.pages[0].text, scene: String(r?.scene || ""), usage, ms: Date.now() - t0 }, 200, h);
    }
    return json({ error: "Unknown action" }, 400, h);
  } catch (e) {
    const code = (e as { code?: string }).code || "provider_error";
    console.log("write-story error", code, String(e).slice(0, 300));
    return json({ error: String((e as Error).message || e).slice(0, 300), code }, code === "rate_limited" ? 429 : 502, h);
  }
});
