/* Base art for the family books (placeholder people only, never a customer photo). Cinema3d house style, GPT Image 2 high, ~15 images (~$2.5) per book.
   Paste into the console on https://noykariok1.github.io/lumora-books/ . The book data is taken from FAM_BOOK below (pasted from family.json),
   so it works even before the page has the updated book text.
     await FAM.run("fam_grand_daughter")        // hero, sheet, cover, p1..p12 -> window.__fam[book][slot] (data URLs) + overlay grid
     await FAM.redo("fam_grand_daughter","p3","correction")
     FAM.show("fam_grand_daughter")             // reopen the overlay (double-click closes)
     await FAM.upload("fam_grand_daughter")     // only after review: covers/base/v2/<book>/<slot>.jpg (base_tmp_upload policy)
   Before run(): set FAM.data = <parsed family.json> (e.g. FAM.data = await (await fetch(<url>)).json()) or rely on PB_FAM on the page.
*/
(() => {
  const SUPA = AI.endpoint.split("/functions/")[0];
  const GRANDPA = "the grandfather (placeholder): a friendly man about 68, short grey hair, clean-shaven, simple round glasses, warm smile; beige knitted cardigan over a light blue shirt, dark trousers";
  const GRANDMA = "the grandmother (placeholder): a warm woman about 65, chin-length silver-grey hair, no glasses, kind smile; soft green blouse, long navy skirt, small pearl earrings";
  const CFG = {
    fam_grand_son: {
      g: "m", face: "soccer_hero",
      hero: "the hero: a boy about 6 (face from image 1), casual colourful clothes: red t-shirt, blue shorts, white sneakers, the same on every page",
      others: [GRANDPA, GRANDMA, "a little girl about 4 from the last bench: brown hair in two puffy pigtails, yellow dress", "the little girl's father: a man about 35, short dark hair, blue t-shirt"],
      props: "a wooden spoon with a small sauce stain, an empty wooden crate, a drinking glass with a teaspoon, a glass salad bowl, a striped picnic mat",
      present: { 4: [2], 6: [2], 7: [2], 8: [2, 3], 11: [2] },
    },
    fam_grand_daughter: {
      g: "f", face: "fairy_garden",
      hero: "the hero: a girl about 6 (face from image 1), casual colourful clothes: plain yellow t-shirt, denim overall shorts, green rubber garden boots, the same on every page",
      others: [GRANDPA, GRANDMA, "the competition judge: a woman about 50 with a straw hat and a clipboard"],
      props: "a pumpkin (small and green early, later orange and huge), a rainbow-striped umbrella, a yellow measuring tape, a wooden cart, a glass jar of pumpkin seeds",
      present: { 11: [2] },
    },
  };
  const S = window.__fam = window.__fam || {};
  const b64 = u => u.split(",")[1], mime = u => (u.match(/^data:([^;]+)/) || [])[1] || "image/jpeg";
  const toData = async url => { const bl = await (await fetch(url)).blob(); return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(bl) }) };
  const book = id => ((FAM.data && FAM.data.books) || PB_FAM.books).find(b => b.id === id);
  const kid = c => c.g === "f" ? "girl" : "boy";
  function prompt(id, slot) {
    const c = CFG[id], B = book(id);
    if (slot === "hero") return `Draw ONE character only: the hero of this book, a generic friendly ${kid(c)} aged 6, based on the reference image's face. Full body, no other characters, no props, no text.\nFixed outfit and look: ${c.hero}`;
    if (slot === "sheet") return `Character reference sheet. The hero exactly as in the hero reference image (${c.hero}). Other characters, each drawn exactly as described: ${c.others.join("; ")}. Key props along the bottom: ${c.props}. No text, names, labels or numbers.`;
    if (slot === "cover") return `Book cover scene (Hebrew): ${B.coverPromptTemplate}\nCharacters: ${[c.hero, GRANDPA, GRANDMA].join("; ")}. Same designs as the reference sheet.`;
    const n = +slot.slice(1), p = B.pages[n - 1];
    const who = [c.hero, GRANDPA, GRANDMA, ...((c.present[n] || []).map(i => c.others[i]))].join("; ");
    return `Page ${n} of 12. The story text on this page (Hebrew, for mood only, never draw it): "${p.textTemplate}"\nScene (Hebrew): ${p.illustrationPromptTemplate}\nCharacters available in this picture (draw only those the scene needs): ${who}\nSame designs, outfits and colours as the reference sheet. Whenever the grandfather or grandmother is in the scene, their faces are clearly visible and lit (they will be personalised later).`;
  }
  async function call(body) {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(AI.endpoint, { method: "POST", headers: { "Content-Type": "application/json", apikey: AI.anonKey, Authorization: "Bearer " + AI.anonKey }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.image) return `data:${d.mime || "image/jpeg"};base64,${d.image}`;
      console.warn("fam retry", i, d.code, d.error); await new Promise(s => setTimeout(s, d.code === "rate_limited" ? 20000 : 5000));
    }
    throw new Error("failed");
  }
  async function draw(id, slot, fix) {
    const c = CFG[id], O = S[id] = S[id] || {};
    const face = slot === "hero" ? (O._face = O._face || await toData(`${SUPA}/storage/v1/object/public/covers/base/v2/${c.face}/hero.jpg?v=20261120d`)) : O.hero;
    const ref = slot === "hero" ? null : slot === "sheet" ? O.hero : O.sheet;
    if (slot !== "hero" && !ref) throw new Error("draw hero and sheet first");
    const body = { mode: "render", engine: "gpt", quality: "high", style: "cinema3d", book: id, gender: c.g, describe: false,
      slot: slot.startsWith("p") ? "page" : slot, aspect: slot === "sheet" ? "16:9" : "4:5", photo: b64(face),
      prompt: prompt(id, slot) + (fix ? `\nCorrection requested by the art director: ${fix}` : "") };
    if (ref) { body.sheet = b64(ref); body.sheetMime = mime(ref) }
    O[slot] = await call(body); console.log("fam done", id, slot); show(id); return O[slot];
  }
  const SLOTS = ["hero", "sheet", "cover", ...Array.from({ length: 12 }, (_, i) => "p" + (i + 1))];
  function show(id) {
    const O = S[id] || {}; let el = document.getElementById("famView");
    if (!el) { el = document.createElement("div"); el.id = "famView"; el.style.cssText = "position:fixed;inset:0;z-index:99999;overflow:auto;background:#0b0f2bdd;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px"; el.ondblclick = () => el.remove(); document.body.appendChild(el) }
    el.innerHTML = SLOTS.filter(s => O[s]).map(s => `<figure style="margin:0;background:#fff;border-radius:10px;padding:6px"><img src="${O[s]}" style="width:100%;display:block;border-radius:6px"><figcaption style="font:600 14px sans-serif;text-align:center">${id} ${s}</figcaption></figure>`).join("");
  }
  async function run(id) {
    const O = S[id] = S[id] || {};
    if (!O.hero) await draw(id, "hero");
    if (!O.sheet) await draw(id, "sheet");
    const q = SLOTS.slice(2).filter(s => !O[s]);
    await Promise.all(Array.from({ length: 5 }, async () => { while (q.length) { const s = q.shift(); try { await draw(id, s) } catch (e) { console.error("fam", id, s, e) } } }));
    const miss = SLOTS.filter(s => !O[s]); console.log("fam", id, "missing:", miss); return miss;
  }
  async function toJpeg(u) { const im = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u }); const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext("2d").drawImage(im, 0, 0); return await new Promise(r => c.toBlob(r, "image/jpeg", .92)) }
  async function upload(id) {
    const O = S[id] || {}, res = {};
    for (const s of SLOTS) { if (!O[s]) continue;
      const r = await fetch(`${SUPA}/storage/v1/object/covers/base/v2/${id}/${s}.jpg`, { method: "POST", headers: { apikey: AI.anonKey, Authorization: "Bearer " + AI.anonKey, "Content-Type": "image/jpeg", "cache-control": "3600" }, body: await toJpeg(O[s]) });
      res[s] = r.ok ? "ok" : r.status + " " + (await r.text()).slice(0, 120) }
    console.log("fam upload", id, res); return res;
  }
  window.FAM = Object.assign(window.FAM || {}, { run, redo: draw, upload, show, slots: SLOTS, cfg: CFG });
  console.log('FAM ready: FAM.data = <family.json>; await FAM.run("fam_grand_daughter")');
})();
