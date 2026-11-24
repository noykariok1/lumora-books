/* Agadibook: "סיפור משלכם". The parent brings an idea, our server writes an original Hebrew story with full nikud,
   and the book then runs through the same pipeline as the ready books (photo -> approved hero -> pages 1-2 preview ->
   cart -> order -> full book in GPT Image 2 -> print / PDF). Loaded after the main script; uses its globals.
   Hidden until OWN_PUBLIC is true: until then the page opens only after #create-own?beta=1 on that device. */
(function () {
"use strict";
const OWN_PUBLIC = false; // noy approves the launch -> true, and add the menu/footer links back
const OWN_BOOKS_KEY = "agadi-own-books", OWN_DRAFT_KEY = "agadi-own-draft", OWN_BETA_KEY = "agadi-own-beta";
const OWN_PAGES = 12; // same as the ready books: cover + 12 picture/text pages (print-order and pricing assume 12)
const OWN_KEEP_DAYS = 30;
const AGES = ["0-2", "3-5", "6-8"];
const TONES = ["חם ומצחיק", "הרפתקני ומותח", "רגוע לפני השינה", "מרגש ומעורר השראה"];
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch (e) { return d } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch (e) { return false } } };
const beta = () => OWN_PUBLIC || ls.get(OWN_BETA_KEY, false) === true;

/* ---------- server ---------- */
const ownEP = () => (AI && AI.endpoint) ? AI.endpoint.replace("generate-character", "write-story") : "";
async function ownCall(body, ms) {
  const ep = ownEP(); if (!ep) throw Object.assign(new Error("offline"), { code: "not_configured" });
  const r = await fetch(ep, { method: "POST", signal: AbortSignal.timeout(ms || 200000), headers: { "Content-Type": "application/json", ...(AI.anonKey ? { apikey: AI.anonKey, Authorization: "Bearer " + AI.anonKey } : {}) }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "write-story error"), { code: d.code || "error" });
  return d;
}
const OWN_ERR = { rate_limited: "יותר מדי בקשות בזמן קצר. נסו שוב בעוד כמה דקות.", not_configured: "כתיבת הסיפור פועלת באתר המלא בלבד.", blocked: "לא הצלחנו לכתוב סיפור מהרעיון הזה. נסו לנסח אותו אחרת.", error: "תקלה זמנית בכתיבת הסיפור. נסו שוב בעוד רגע." };
const ownErr = e => OWN_ERR[e && e.code] || (e && e.name === "TimeoutError" ? "הכתיבה לקחה יותר מדי זמן. נסו שוב." : OWN_ERR.error);
const NAME = "{{childName}}";
const fill = (t, n) => String(t || "").split(NAME).join(n);
const unfill = (t, n) => n ? String(t || "").split(n).join(NAME) : String(t || "");

/* ---------- book registry (this device) ---------- */
function ownBooks() { const all = ls.get(OWN_BOOKS_KEY, {}); const now = Date.now(); let ch = false; for (const k of Object.keys(all)) if (!all[k] || now - (all[k].createdAt || 0) > OWN_KEEP_DAYS * 864e5) { delete all[k]; ch = true } if (ch) ls.set(OWN_BOOKS_KEY, all); return all }
function ownRegister(b) { b.custom = true; if (typeof PB_OWN === "object") PB_OWN[b.id] = b; if (typeof PB_V2 !== "undefined") PB_V2.add(b.id) }
function ownSaveBook(b) { const all = ownBooks(); all[b.id] = b; const ids = Object.keys(all).sort((x, y) => (all[y].createdAt || 0) - (all[x].createdAt || 0)); for (const k of ids.slice(12)) delete all[k]; if (!ls.set(OWN_BOOKS_KEY, all)) throw new Error("storage full"); ownRegister(b) }
Object.values(ownBooks()).forEach(ownRegister);

/* image prompts (English; the house art direction is added by the server through pbArt -> style cinema3d) */
function castFor(b, ids) { return (b.characters || []).filter(c => c.id !== "hero" && (!ids || ids.includes(c.id))) }
function castLine(cs) { return cs.length ? "Supporting characters in this picture (draw each exactly as described and as in the reference sheet): " + cs.map(c => `${c.role || "character"}: ${c.appearance}`).join("; ") + "." : "No other characters unless the scene mentions background figures." }
function ownPrompts(b) {
  const head = "TASK: create a completely NEW children's picture-book illustration from scratch, portrait 4:5. Image 1 is only a reference for who the real child is; nothing of its background or photo texture may appear.";
  const world = b.world ? "The world of this book: " + b.world : "";
  const outfit = b.heroOutfit ? "The hero always wears: " + b.heroOutfit + "." : "";
  const props = (b.recurringProps || []).length ? "Recurring objects (same look every time they appear): " + b.recurringProps.join("; ") + "." : "";
  const tail = "Absolutely no text, letters, numbers, signs or logos anywhere in the picture.";
  b.coverPromptTemplate = [head, "THE COVER of the book.", world, outfit, castLine(castFor(b)), props, "Scene: " + b.coverScene, tail].filter(Boolean).join("\n");
  b.pages.forEach(p => { p.illustrationPromptTemplate = [head, `Page ${p.pageNumber} of ${OWN_PAGES}.`, world, outfit, castLine(castFor(b, p.cast || [])), props, "Scene: " + p.scene, tail].filter(Boolean).join("\n") });
  b.heroAppearanceRule = (b.heroOutfit ? "Outfit for this book: " + b.heroOutfit + ". " : "") + "No text or logos on clothes.";
  return b;
}

/* draw one page of an own book: no pre-made page exists, so it is drawn from scratch with the approved hero
   (+ a one-time sheet of the supporting characters, glued next to the hero so one reference holds both) */
const CAST_RUN = {};
async function ownCastRef(m, b, hero) {
  const cs = castFor(b); if (!cs.length) return hero;
  const have = await pbImg(m.id, "castref"); if (have) return have;
  if (CAST_RUN[m.id]) return CAST_RUN[m.id];
  return CAST_RUN[m.id] = (async () => {
    try {
      const photo = await pbImg(m.id, "photo");
      const sheet = await aiCall({ mode: "render", engine: PB_ENGINE, quality: "medium", photo: b64(photo || hero), sheet: b64(hero), sheetMime: pbMime(hero), aspect: "16:9", gender: pbG(b), refIsArt: true, ...pbArt(b, "sheet"),
        prompt: "TASK: a character reference sheet of the SUPPORTING characters of this book only (NOT the hero): each one full body, front three-quarter view, side by side at the same scale, evenly lit, on a plain soft light-cream background, no text or labels. Match the rendering style of image 2. " + (b.world ? "World and palette: " + b.world + " " : "") + "Characters: " + cs.map(c => `${c.role || "character"}: ${c.appearance}`).join("; ") });
      const [hi, si] = await Promise.all([loadImg(hero), loadImg(sheet)]);
      const H = 1024, hw = Math.round(hi.width * H / hi.height), sw = Math.round(si.width * H / si.height);
      const c = document.createElement("canvas"); c.width = hw + sw + 24; c.height = H; const x = c.getContext("2d");
      x.fillStyle = "#F7F1E6"; x.fillRect(0, 0, c.width, H); x.drawImage(hi, 0, 0, hw, H); x.drawImage(si, hw + 24, 0, sw, H);
      const u = c.toDataURL("image/jpeg", .9); await pbSetImg(m.id, "cast", sheet); await pbSetImg(m.id, "castref", u); return u;
    } catch (e) { console.warn("cast sheet", e); return hero } finally { delete CAST_RUN[m.id] }
  })();
}
window.ownDrawPage = async function (m, slot, hero, quality) {
  const b = pbBy(m.book); const photo = await pbImg(m.id, "photo"); if (!photo) throw Object.assign(new Error("photo deleted"), { code: "no_photo" });
  const ref = await ownCastRef(m, b, hero), glued = ref !== hero;
  const lead = glued ? "The LAST image is the approved reference for this book: on its LEFT the hero exactly as approved by the parent (face, hair, skin, proportions), on its RIGHT the supporting characters. Draw everyone exactly like that.\n" : "The LAST image is the hero exactly as approved by the parent: keep the face, hair, skin tone and proportions identical.\n";
  const u = await aiCall({ mode: "render", engine: PB_ENGINE, ...(quality ? { quality } : {}), photo: b64(photo), extra: await pbExtra(m), sheet: b64(ref), sheetMime: pbMime(ref), prompt: lead + pbSlotPrompt(b, slot), aspect: "4:5", gender: pbG(b), ...(m.src === "char" ? { refIsArt: true } : {}), ...pbArt(b, slot === "cover" ? "cover" : "page") });
  await PBDB.del("i:" + m.id + ":qa_" + slot);
  if (typeof PB_QA !== "undefined" && PB_QA) { const c = await pbCheck(hero, null, u); if (c && (c.found === false || c.score <= 5)) await pbSetImg(m.id, "qa_" + slot, String(c.issues || "").slice(0, 300) || "1") }
  return u;
};
/* the order keeps the story text, so the team can see what was written even without the device */
window.ownOrderInfo = function (item) { const b = pbBy(String(item.book || "").slice(3)); if (!b || !b.custom) return null; const n = (item.child && item.child.name) || b.heroName || "";
  return { title: fill(b.titleTemplate, n), idea: b.idea, age: b.ageRange, tone: b.tone, pages: b.pages.map(p => fill(p.textTemplate, n)) } };

/* ---------- the studio (5 steps; steps 4-5 are the shared photo/hero/pages flow) ---------- */
const STAGES = ["רעיון", "גיבור", "סיפור", "דמות ואיורים", "הזמנה"];
function blankDraft() { return { stage: 1, idea: "", details: "", lesson: "", age: "3-5", tone: TONES[0], name: "", gender: "f", story: null, edited: {}, nik: {}, bookId: null } }

routes["create-own"] = {
  title: () => "סיפור משלכם",
  html() {
    return `<div class="wrap page-head"><span class="eyebrow">סטודיו</span><h1>כותבים סיפור משלכם</h1><p class="lead">מספרים לנו רעיון במשפט או שניים, ואנחנו כותבים ספר מקורי עם ניקוד מלא, ש${"<b>"}הילד שלכם${"</b>"} הוא הגיבור שלו. אתם עורכים כל מילה, ואז מאיירים אותו עם הדמות של הילד, באותו סגנון של הספרים שלנו.</p></div><div class="wrap wiz" id="own" style="padding-top:12px"></div>`;
  },
  mount(m, q) {
    if (q && q.beta === "1") ls.set(OWN_BETA_KEY, true);
    if (q && q.beta === "0") { try { localStorage.removeItem(OWN_BETA_KEY) } catch (e) { } }
    const W = $("#own", m);
    if (!beta()) { W.innerHTML = `<div class="box stack" style="max-width:640px"><h2>בקרוב</h2><p class="muted">אנחנו מסיימים לבנות את הסטודיו לכתיבת סיפור משלכם. בינתיים אפשר ליצור ספר מאויר עם הילד שלכם מתוך הספרים המוכנים.</p><a class="btn btn-primary" href="#personal" style="align-self:flex-start">לספרים</a></div>`; return }
    let O = Object.assign(blankDraft(), ls.get(OWN_DRAFT_KEY, {}) || {});
    if (q && q.new === "1") O = blankDraft();
    const persist = () => ls.set(OWN_DRAFT_KEY, O);
    let alive = true; if (typeof cleanup !== "undefined") cleanup.push(() => { alive = false });
    const render = () => {
      persist(); const st = O.stage;
      W.innerHTML = `<aside><div class="stepper">${STAGES.map((s, i) => `<button class="st ${i + 1 < st ? "done" : ""} ${i + 1 === st ? "cur" : ""}" ${i + 1 < st && i < 3 ? `data-j="${i + 1}"` : ""}><i>${i + 1 < st ? "✓" : i + 1}</i><span>${s}</span></button>`).join("")}</div></aside><div class="wiz-main"><div class="progressbar"><i style="width:${(st - 1) / 4 * 100}%"></i></div><div id="ob" class="stack" style="gap:20px"></div></div>`;
      $$("[data-j]", W).forEach(b => b.onclick = () => { O.stage = +b.dataset.j; render() });
      ST[st]($("#ob", W)); window.scrollTo(0, 0);
    };
    const nav = label => `<div class="wiz-nav">${O.stage > 1 ? '<button class="btn btn-ghost" data-b>חזרה</button>' : "<span></span>"}${label ? `<button class="btn btn-primary" data-n>${label}</button>` : ""}</div>`;
    const bind = (el, fn) => { const b = $("[data-b]", el); if (b) b.onclick = () => { O.stage--; render() }; const n = $("[data-n]", el); if (n) n.onclick = fn };
    const errAt = (el, id, t) => { const e = $("#" + id, el); e.textContent = t; e.hidden = !t };
    const he = () => O.gender === "f";

    const ST = {
      1: el => {
        el.innerHTML = `<h2>מה הרעיון?</h2><div class="box stack">
          <label class="f" for="oIdea">במשפט או שניים <span class="hint">למשל: ילדה שמגלה שהחתול שלה יודע לדבר, והם יוצאים יחד להחזיר את הירח לשמיים</span><textarea class="inp" id="oIdea" maxlength="600">${esc(O.idea)}</textarea></label><span class="err-msg" id="oE" hidden></span>
          <label class="f" for="oDet">מי עוד בסיפור? <span class="hint">לא חובה. אחים, חברים, סבא וסבתא, חיית מחמד, מקום אהוב, משהו שהילד אוהב. למשל: אחות קטנה בשם מאיה, והכלב בוני</span><textarea class="inp" id="oDet" maxlength="400" style="min-height:70px">${esc(O.details)}</textarea></label>
          <label class="f" for="oLes">מה תרצו שהילד ייקח מהסיפור? <span class="hint">לא חובה. למשל: שמותר לפחד ועדיין לנסות</span><input class="inp" id="oLes" maxlength="160" value="${esc(O.lesson)}"></label>
          <div class="grid2"><label class="f" for="oAge">לאיזה גיל<select class="inp" id="oAge">${AGES.map(a => `<option ${O.age === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
          <label class="f" for="oTone">אווירה<select class="inp" id="oTone">${TONES.map(a => `<option ${O.tone === a ? "selected" : ""}>${a}</option>`).join("")}</select></label></div>
          <p class="small muted">הספר כולל כריכה ו־${OWN_PAGES} עמודים מאוירים, כמו כל הספרים שלנו.</p></div>${nav("להמשיך")}`;
        bind(el, () => {
          const v = $("#oIdea", el).value.trim(); if (v.length < 8) return errAt(el, "oE", "כתבו לפחות משפט קצר, כדי שנדע על מה הסיפור.");
          const changed = v !== O.idea || $("#oDet", el).value.trim() !== O.details || $("#oLes", el).value.trim() !== O.lesson || $("#oAge", el).value !== O.age || $("#oTone", el).value !== O.tone;
          O.idea = v; O.details = $("#oDet", el).value.trim(); O.lesson = $("#oLes", el).value.trim(); O.age = $("#oAge", el).value; O.tone = $("#oTone", el).value;
          if (changed && O.story) O.stale = true; O.stage = 2; render();
        });
      },
      2: el => {
        el.innerHTML = `<h2>מי ${he() ? "הגיבורה" : "הגיבור"}?</h2><div class="box stack"><div class="grid2"><label class="f" for="hName">השם של הילד<input class="inp" id="hName" maxlength="20" autocomplete="off" value="${esc(O.name)}" placeholder="${he() ? "למשל: נועה" : "למשל: איתי"}"></label>
          <div class="stack" style="gap:6px"><b class="small">הסיפור ייכתב בלשון</b><div class="seg">${[["m", "זכר"], ["f", "נקבה"]].map(([k, v]) => `<button type="button" data-g="${k}" aria-pressed="${O.gender === k}">${v}</button>`).join("")}</div></div></div><span class="err-msg" id="hE" hidden></span>
          <p class="small muted">את הדמות עצמה נצייר בשלב הבא, מתמונה של הילד או מדמות ששמרתם באזור האישי. השם לא נשלח לשירות הכתיבה: הסיפור נכתב עם מקום לשם, והשם מוכנס רק אצלכם.</p></div>${nav("לכתוב את הסיפור")}`;
        $$("[data-g]", el).forEach(b => b.onclick = () => { if (O.gender !== b.dataset.g && O.story) O.stale = true; O.gender = b.dataset.g; $$("[data-g]", el).forEach(x => x.setAttribute("aria-pressed", x === b)) });
        bind(el, () => {
          const n = $("#hName", el).value.trim().replace(/\s+/g, " "); if (!n) return errAt(el, "hE", "מה השם של הילד?"); if (/[<>{}]/.test(n)) return errAt(el, "hE", "השם יכול להכיל רק אותיות ורווחים");
          O.name = n; O.stage = 3; render();
        });
      },
      3: el => {
        const s = O.story;
        if (!s || O.stale) {
          el.innerHTML = `<h2>כותבים את הסיפור של ${esc(O.name)}</h2><div class="box stack"><div class="pb-wait"><span class="spin" aria-hidden="true"></span><span id="wMsg">קוראים את הרעיון שלכם...</span></div><p class="small muted">זה לוקח בערך דקה. אפשר להישאר בדף.</p><span class="err-msg" id="wE" hidden></span><div class="row" id="wRow" hidden><button class="btn btn-primary" id="wTry">לנסות שוב</button><button class="btn btn-ghost" data-b>לשנות את הרעיון</button></div></div>`;
          const msgs = ["בונים עלילה עם התחלה, אמצע וסוף...", "מחפשים פזמון קליט שחוזר בסיפור...", `כותבים את העמודים בלשון ${he() ? "נקבה" : "זכר"}...`, "מוסיפים הומור ורגעים קטנים...", "מתכננים איור לכל עמוד...", "עוד כמה שניות..."];
          let k = 0; const t = setInterval(() => { const x = $("#wMsg", el); if (!x) return clearInterval(t); x.textContent = msgs[Math.min(k++, msgs.length - 1)] }, 9000);
          const go = async () => {
            $("#wRow", el).hidden = true; errAt(el, "wE", "");
            try {
              const r = await ownCall({ action: "write", idea: O.idea, details: O.details, lesson: O.lesson, age: O.age, tone: O.tone, gender: O.gender });
              clearInterval(t); if (!alive) return;
              if (!r.ok) { errAt(el, "wE", r.reason || "לא הצלחנו לכתוב סיפור מהרעיון הזה. נסו לנסח אותו אחרת."); $("#wRow", el).hidden = false; $("#wTry", el).hidden = true; bind(el); return }
              O.story = r.story; O.stale = false; O.edited = {}; O.nik = {}; O.bookId = null; persist(); render(); ownNikud(O, persist);
            } catch (e) { clearInterval(t); if (!alive) return; errAt(el, "wE", ownErr(e)); $("#wRow", el).hidden = false; $("#wTry", el).hidden = false; bind(el) }
          };
          $("#wTry", el).onclick = go; bind(el); go(); return;
        }
        el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>הסיפור של ${esc(O.name)}</h2><button class="btn btn-ghost btn-sm" id="regen">לכתוב סיפור אחר</button></div>
          <p class="muted">${esc(fill(s.summary, O.name))}</p>
          <div class="box stack"><label class="f" for="oTitle">שם הספר<input class="inp" id="oTitle" maxlength="50" value="${esc(fill(s.title, O.name))}"></label>
          <p class="small muted">ערכו כל עמוד כמו שאתם רוצים. אפשר גם לבקש שינוי במילים, ואנחנו נכתוב את העמוד מחדש ונתאים גם את האיור. ${O.nikDone ? "הניקוד מוכן." : '<span id="nkS">מוסיפים ניקוד מלא ברקע...</span>'}</p></div>
          <div class="stack" id="pe" style="gap:14px">${s.pages.map((p, i) => `<div class="box stack" style="gap:8px"><div class="row" style="justify-content:space-between"><b class="small">עמוד ${i + 1}</b><button class="btn btn-ghost btn-sm" data-rv="${i}">לבקש שינוי</button></div>
            <label class="sr" for="pt${i}">טקסט עמוד ${i + 1}</label><textarea class="inp" id="pt${i}" data-t="${i}" maxlength="600" style="min-height:96px">${esc(fill(p.text, O.name))}</textarea>
            <div class="row" data-rvbox="${i}" hidden><input class="inp" style="flex:1;min-width:200px" maxlength="300" placeholder="למשל: שהכלב יעזור לה כאן, ושיהיה יותר מצחיק" data-rq="${i}"><button class="btn btn-soft btn-sm" data-rgo="${i}">לכתוב מחדש</button></div><span class="small muted" data-rm="${i}"></span></div>`).join("")}</div>
          <span class="err-msg" id="sE" hidden></span>${nav("להמשיך לדמות ולאיורים")}`;
        $("#oTitle", el).oninput = e => { s.title = unfill(e.target.value, O.name); O.nik.title = null; persist() };
        $$("[data-t]", el).forEach(t => t.oninput = () => { const i = +t.dataset.t; s.pages[i].text = unfill(t.value, O.name); O.edited[i] = true; delete O.nik[i]; persist() });
        $$("[data-rv]", el).forEach(b => b.onclick = () => { const bx = $(`[data-rvbox="${b.dataset.rv}"]`, el); bx.hidden = !bx.hidden; if (!bx.hidden) bx.querySelector("input").focus() });
        $$("[data-rgo]", el).forEach(b => b.onclick = async () => {
          const i = +b.dataset.rgo, req = $(`[data-rq="${i}"]`, el).value.trim(), msg = $(`[data-rm="${i}"]`, el); if (!req) return;
          b.disabled = true; msg.textContent = "כותבים את העמוד מחדש...";
          try { const r = await ownCall({ action: "revise", story: { pages: s.pages }, index: i, request: req, gender: O.gender, age: O.age }, 120000); if (!alive) return;
            if (r.text) { s.pages[i].text = r.text; if (r.scene) s.pages[i].scene = r.scene; delete O.edited[i]; delete O.nik[i]; persist(); $(`#pt${i}`, el).value = fill(r.text, O.name); msg.textContent = "העמוד נכתב מחדש. אפשר להמשיך לערוך."; ownNikud(O, persist) }
          } catch (e) { msg.textContent = ownErr(e) } b.disabled = false });
        $("#regen", el).onclick = () => { if (!confirmInline($("#regen", el), "ללחוץ שוב: הסיפור הנוכחי יוחלף")) return; O.stale = true; render() };
        bind(el, async () => {
          if (s.pages.some(p => !String(p.text).trim())) return errAt(el, "sE", "יש עמוד ריק. כתבו בו משהו.");
          if (!s.title.trim()) return errAt(el, "sE", "תנו לספר שם.");
          const n = $("[data-n]", el); n.disabled = true; n.textContent = "מכינים את הספר...";
          try { await ownNikud(O, persist, true); const b = ownBuildBook(O); ownSaveBook(b); O.bookId = b.id; O.stage = 4; persist(); location.hash = "#personal?book=" + b.id }
          catch (e) { console.error(e); n.disabled = false; n.textContent = "להמשיך לדמות ולאיורים"; errAt(el, "sE", String(e && e.message) === "storage full" ? "אין מספיק מקום בדפדפן. מחקו ספרים ישנים ונסו שוב." : "לא הצלחנו לשמור את הספר במכשיר. נסו שוב.") }
        });
      },
      4: el => {
        const b = O.bookId && pbBy(O.bookId);
        el.innerHTML = `<h2>הדמות והאיורים</h2><div class="box stack"><p class="muted">${b ? `הסיפור "${esc(fill(b.titleTemplate, O.name))}" שמור. ממשיכים לדמות של ${esc(O.name)}, לעמודים לדוגמה ולהזמנה.` : "הספר לא נמצא במכשיר הזה."}</p>
          <div class="row">${b ? `<a class="btn btn-primary" href="#personal?book=${b.id}">להמשיך לדמות</a>` : ""}<button class="btn btn-ghost" id="oNew">להתחיל סיפור חדש</button></div></div>${nav("")}`;
        bind(el); $("#oNew", el).onclick = () => { O = blankDraft(); render() };
      },
      5: el => { O.stage = 4; ST[4](el) },
    };
    render();
  },
};

/* nikud for every page (and the title) that does not have it yet; strict server check, plain text if it fails */
const NIK_RUN = new WeakMap();
async function ownNikud(O, persist, wait) {
  if (NIK_RUN.has(O)) { if (wait) return NIK_RUN.get(O); return }
  const s = O.story; if (!s) return;
  const p = (async () => {
    const todo = s.pages.map((_, i) => i).filter(i => O.nik[i] === undefined);
    const wantTitle = O.nik.title == null;
    const texts = todo.map(i => s.pages[i].text); if (wantTitle) texts.push(s.title);
    if (!texts.length) { O.nikDone = true; return }
    try {
      const r = await ownCall({ action: "nikud", texts, gender: O.gender }, 180000);
      todo.forEach((i, k) => { const t = r.texts && r.texts[k]; if (s.pages[i].text === texts[k]) O.nik[i] = t || null });
      if (wantTitle && s.title === texts[texts.length - 1]) O.nik.title = (r.texts && r.texts[texts.length - 1]) || "";
      O.nikDone = s.pages.every((_, i) => O.nik[i] !== undefined); persist();
      const x = document.getElementById("nkS"); if (x) x.textContent = O.nikDone ? "הניקוד מוכן." : "";
    } catch (e) { console.warn("nikud", e) } // the book still works without nikud (the reader shows plain text)
  })().finally(() => NIK_RUN.delete(O));
  NIK_RUN.set(O, p); if (wait) return p;
}

function ownBuildBook(O) {
  const s = O.story, g = O.gender;
  const id = O.bookId && pbBy(O.bookId) && !pbBy(O.bookId).ordered ? O.bookId : "own_" + uid().replace(/[^a-z0-9]/gi, "").slice(0, 10).toLowerCase();
  const chars = (s.characters || []).slice(0, 3).map((c, i) => ({ id: String(c.id || "c" + (i + 1)), nameTemplate: String(c.name || ""), role: String(c.role || ""), appearance: String(c.appearance || "") }));
  const b = {
    id, custom: true, version: 1, createdAt: Date.now(), audience: g === "f" ? "בנות" : "בנים", ageRange: O.age, genre: "סיפור משלכם", pageCount: OWN_PAGES,
    heroName: O.name, idea: O.idea, details: O.details, lesson: O.lesson, tone: O.tone, summary: s.summary || "", refrain: s.refrain || "",
    titleTemplate: String(s.title).trim(), titleTemplateNikud: O.nik.title || "", illustrationStyle: "cinema3d", world: s.world || "", heroOutfit: s.heroOutfit || "",
    characters: [{ id: "hero", nameTemplate: NAME, role: g === "f" ? "הגיבורה" : "הגיבור", appearance: "" }, ...chars],
    recurringProps: (s.props || []).slice(0, 4).map(String), coverScene: s.coverScene || "",
    pages: s.pages.slice(0, OWN_PAGES).map((p, i) => ({ pageNumber: i + 1, textTemplate: String(p.text).trim(), textTemplateNikud: O.nik[i] || "", scene: String(p.scene || ""), cast: (p.cast || []).map(String) })),
  };
  return ownPrompts(b);
}

/* the page may have been opened before this file loaded */
if (/^#create-own/.test(location.hash) && typeof route === "function") route();
})();
