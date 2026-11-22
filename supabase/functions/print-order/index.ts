// ספר וחצי: build print-ready PDFs for an order and send them to the printer (Be'eri print).
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   PRINT_EMAIL      the printer's order inbox (required to send)
//   RESEND_API_KEY   email sending via resend.com (required to send; needs a verified sender domain)
//   PRINT_FROM       optional sender, e.g. "ספר וחצי <orders@your-domain.co.il>"
//   PRINT_CC         optional copy to the owner
//   CUSTOMER_FROM    sender of the customer emails, e.g. "ספר וחצי <orders@your-domain.co.il>" (falls back to PRINT_FROM)
//   OPENAI_API_KEY / OPEN_API_KEY  draws the 5 coloring pages (gpt-image-2, OPENAI_IMAGE_MODEL optional)
//   OWNER_EMAIL      optional: gets a copy (bcc) of every customer email
// Customer email: right after "build", every customer gets an order confirmation with the order number and a
// download link to the full book as a PDF (hardcover and digital alike). Rows in table order_emails; while the
// sender domain is not verified the row stays "pending"/"failed" and { action: "mail", orderId } sends it again.
// Book spec (noy 2026-11-22: every book 20x20 cm; bleed and spine still to confirm with Be'eri): trim 200x200 mm, 3 mm bleed, 300 dpi.
// Per printed book: cover.pdf = ONE spread page [front | spine | back] (Hebrew book: front on the left when laid flat,
// spine width taken from the site's print/14.jpg), interior.pdf = 26 pages: opening page, 12 x (picture, text), end page.
// Coloring booklet (free printed gift with every hardcover, PDF for digital buyers): softcover 20x20, saddle stitch,
// coloring-cover.pdf = one spread [front | back], coloring-interior.pdf = 12 pages (title, blank, 5 x (coloring page, blank)).
// The 5 line-art pages are drawn by OpenAI from 5 of the ordered book's own pages (same child, same story moments),
// in the background after "build"; then the customer email goes out. Never redrawn once they exist.
// Requests (POST JSON):
//   { action: "build", orderId }  called by the site right after the order files are uploaded
//   { action: "coloring", orderId } retry the coloring booklet (e.g. after an OpenAI credit top-up)
//   { action: "send",  orderId }  called by the database when print_jobs.status becomes 'approved'
//                                 (later: by the payment webhook). Sends only if the row really is approved.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const MM = 72 / 25.4, TRIM_W = 200, TRIM_H = 200, BLEED = 3, SPINE_DEFAULT = 6;
const PW = (TRIM_W + 2 * BLEED) * MM, PH = (TRIM_H + 2 * BLEED) * MM;
const ART_ANCHOR = 0.4; // 4:5 art on a square page: keep a bit more of the top (faces) than the bottom
const COLOR_PAGES = [1, 4, 6, 9, 12]; // story moments for the coloring booklet
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("OPEN_API_KEY") || "";
const OPENAI_MODEL = Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-2";
const BRAND = "ספר וחצי";
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...H, "Content-Type": "application/json" } });

async function file(path: string) {
  const { data, error } = await db.storage.from("orders").download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

function page(pdf: PDFDocument) {
  const p = pdf.addPage([PW, PH]);
  p.setBleedBox(0, 0, PW, PH);
  p.setTrimBox(BLEED * MM, BLEED * MM, TRIM_W * MM, TRIM_H * MM);
  return p;
}
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50;
const embed = (pdf: PDFDocument, b: Uint8Array) => isPng(b) ? pdf.embedPng(b) : pdf.embedJpg(b);
async function fill(pdf: PDFDocument, bytes: Uint8Array) { // cover-fit an image over the full bleed area
  const img = await embed(pdf, bytes);
  const s = Math.max(PW / img.width, PH / img.height);
  const w = img.width * s, h = img.height * s;
  // pdf y runs upwards: anchor 0.4 from the top = crop 40% of the overflow at the top, 60% at the bottom
  page(pdf).drawImage(img, { x: (PW - w) / 2, y: (PH - h) * (1 - ART_ANCHOR), width: w, height: h });
}
function blank(pdf: PDFDocument) { page(pdf).drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: rgb(1, 1, 1) }); }
// one spread page: [left | spine | right], each panel trim size, bleed around the whole spread (Hebrew book: front = left)
async function spread(pdf: PDFDocument, left: Uint8Array, right: Uint8Array | null, spine: Uint8Array | null, spineMM: number) {
  const S = spineMM * MM, W = 2 * TRIM_W * MM + S + 2 * BLEED * MM;
  const p = pdf.addPage([W, PH]);
  p.setBleedBox(0, 0, W, PH);
  p.setTrimBox(BLEED * MM, BLEED * MM, W - 2 * BLEED * MM, TRIM_H * MM);
  p.drawRectangle({ x: 0, y: 0, width: W, height: PH, color: rgb(0.102, 0.09, 0.282) });
  const put = async (b: Uint8Array, x: number) => { const im = await embed(pdf, b); const s = Math.max(PW / im.width, PH / im.height); p.drawImage(im, { x: x + (PW - im.width * s) / 2, y: (PH - im.height * s) / 2, width: im.width * s, height: im.height * s }); };
  if (right) await put(right, W - PW); // its left bleed slides under the spine
  await put(left, 0);
  const sx = (BLEED + TRIM_W) * MM;
  if (spine && S > 0) { const im = await embed(pdf, spine); p.drawImage(im, { x: sx, y: 0, width: S, height: PH }); }
  else if (S > 0) p.drawRectangle({ x: sx, y: 0, width: S, height: PH, color: rgb(0.102, 0.09, 0.282) });
  return p;
}
async function spineMMOf(pdf: PDFDocument, b: Uint8Array | null) { // the site draws print/14.jpg exactly spineMM wide
  if (!b) return SPINE_DEFAULT;
  const im = await embed(pdf, b);
  return Math.round(((TRIM_H + 2 * BLEED) * im.width / im.height) * 10) / 10;
}
async function save(path: string, doc: PDFDocument) {
  const { error } = await db.storage.from("orders").upload(path, new Blob([await doc.save()], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  return path;
}

// the full book as one PDF for the family: front cover, 12 picture + text spreads, back cover
async function buildReader(orderId: string, pid: string) {
  const dir = `${orderId}/${pid}`;
  const doc = await PDFDocument.create();
  doc.setTitle(BRAND);
  const cover = await file(`${dir}/print/00.jpg`);
  if (!cover) throw new Error(`missing cover for ${pid}`);
  await fill(doc, cover);
  for (let i = 1; i <= 12; i++) {
    const art = await file(`${dir}/p${i}.jpg`), text = await file(`${dir}/print/${String(i).padStart(2, "0")}.jpg`);
    if (!art || !text) throw new Error(`missing page ${i} for ${pid}`);
    await fill(doc, art);
    await fill(doc, text);
  }
  const back = await file(`${dir}/print/13.jpg`);
  if (back) await fill(doc, back);
  const path = `${dir}/book.pdf`;
  const { error } = await db.storage.from("orders").upload(path, new Blob([await doc.save()], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(`upload book: ${error.message}`);
  return path;
}

const FMT: Record<string, string> = { hard: "כריכה קשה + PDF", gift: "כריכה קשה + PDF", digital: "ספר דיגיטלי (PDF)" };

// ---- coloring booklet ----
const COLOR_PROMPT = `Turn the FIRST image (a page from a children's picture book) into a page for a children's COLORING BOOK.
Pure black outlines on a pure white background. No gray, no shading, no hatching, no color, no filled black areas except small details like pupils.
Bold, clean, smooth, closed outlines (like a professional coloring book for ages 3-8), with large areas that are easy to color.
Keep the SAME child as the main character: same face, hairstyle, outfit and the same pose and action as in the first image. The SECOND image shows that child's character for reference.
Keep the same story moment and the main objects, but simplify the background into a few large shapes. Square composition, child large and centered, nothing touching the edges.
No text, no letters, no numbers, no frame, no border, no signature.`;
function fromB64(b: string) { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function lineArt(pageJpg: Uint8Array, heroJpg: Uint8Array | null) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not set");
  let last = "";
  for (const size of ["2048x2048", "1024x1024"]) {
    const fd = new FormData();
    fd.append("model", OPENAI_MODEL); fd.append("prompt", COLOR_PROMPT); fd.append("size", size);
    fd.append("quality", "medium"); fd.append("output_format", "png"); fd.append("n", "1");
    fd.append("image[]", new Blob([pageJpg], { type: "image/jpeg" }), "page.jpg");
    if (heroJpg) fd.append("image[]", new Blob([heroJpg], { type: "image/jpeg" }), "hero.jpg");
    const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d?.data?.[0]?.b64_json) return fromB64(d.data[0].b64_json);
    last = String(d?.error?.message || `OpenAI HTTP ${r.status}`);
    if (!(r.status === 400 && /size/i.test(last))) break;
  }
  throw new Error(last.slice(0, 200));
}
// draws the missing line-art pages (never redraws one that exists), then builds the booklet PDFs
async function buildColoring(orderId: string, pid: string) {
  const dir = `${orderId}/${pid}`;
  const hero = await file(`${dir}/hero.jpg`);
  const front = await file(`${dir}/print/15.jpg`), back = await file(`${dir}/print/16.jpg`), title = await file(`${dir}/print/17.jpg`);
  if (!front) throw new Error("missing coloring cover art (print/15.jpg)"); // checked before any paid drawing
  const arts = await Promise.all(COLOR_PAGES.map(async (n, k) => {
    const path = `${dir}/coloring/c${k + 1}.png`;
    const have = await file(path);
    if (have) return have;
    const src = await file(`${dir}/p${n}.jpg`);
    if (!src) throw new Error(`missing page ${n}`);
    let png: Uint8Array | null = null, err: unknown = null;
    for (let t = 0; t < 2 && !png; t++) { try { png = await lineArt(src, hero); } catch (e) { err = e; if (t === 0) await new Promise((r) => setTimeout(r, 4000)); } }
    if (!png) throw err;
    await db.storage.from("orders").upload(path, new Blob([png], { type: "image/png" }), { upsert: true, contentType: "image/png" });
    return png;
  }));
  const linePage = async (pdf: PDFDocument, png: Uint8Array) => { // white page, line art inside an 8 mm margin from the trim
    const p = page(pdf); p.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: rgb(1, 1, 1) });
    const im = await pdf.embedPng(png); const box = (TRIM_W - 16) * MM, s = Math.min(box / im.width, box / im.height);
    p.drawImage(im, { x: (PW - im.width * s) / 2, y: (PH - im.height * s) / 2, width: im.width * s, height: im.height * s });
  };
  const cover = await PDFDocument.create(); cover.setTitle(`${orderId} ${pid} coloring cover`);
  await spread(cover, front, back, null, 0); // saddle stitch: no spine
  const inner = await PDFDocument.create(); inner.setTitle(`${orderId} ${pid} coloring interior`);
  if (title) await fill(inner, title); else blank(inner);
  blank(inner);
  for (const a of arts) { await linePage(inner, a); blank(inner); } // one-sided, so markers don't show through
  const reader = await PDFDocument.create(); reader.setTitle(`${BRAND} · ספר צביעה`); // for the family, to print at home
  await fill(reader, front); if (title) await fill(reader, title);
  for (const a of arts) await linePage(reader, a);
  if (back) await fill(reader, back);
  return { cover: await save(`${dir}/coloring-cover.pdf`, cover), interior: await save(`${dir}/coloring-interior.pdf`, inner), book: await save(`${dir}/coloring.pdf`, reader) };
}
// background job after "build": the coloring booklet for every book in the order, then the customer email
async function coloringJob(orderId: string) {
  const res: Record<string, unknown> = {};
  const { data: job } = await db.from("print_jobs").select("books").eq("order_id", orderId).maybeSingle();
  const { data: mail } = await db.from("order_emails").select("books").eq("order_id", orderId).maybeSingle();
  const pids = new Set<string>([...(job?.books || []).map((b: any) => b.project), ...(mail?.books || []).map((b: any) => b.project)].filter(Boolean));
  const done: Record<string, any> = {};
  for (const pid of pids) {
    try { done[pid] = await buildColoring(orderId, pid); res[pid] = "ok"; }
    catch (e) { done[pid] = { error: String((e as Error).message || e) }; res[pid] = done[pid].error; console.warn("coloring", orderId, pid, e); }
  }
  if (job?.books) await db.from("print_jobs").update({ books: job.books.map((b: any) => ({ ...b, coloring: done[b.project] || b.coloring || null })) }).eq("order_id", orderId);
  if (mail?.books) await db.from("order_emails").update({ books: mail.books.map((b: any) => ({ ...b, coloring: done[b.project]?.book || b.coloring || null })) }).eq("order_id", orderId);
  res.mail = await mailCustomer(orderId);
  return res;
}

const esc = (t: unknown) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ils = (n: unknown) => `${Number(n || 0)} ₪`;

async function mailCustomer(orderId: string) {
  const { data: row } = await db.from("order_emails").select("*").eq("order_id", orderId).maybeSingle();
  if (!row) return { error: "no mail row" };
  if (row.status === "sent") return { ok: true, already: true };
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("CUSTOMER_FROM") || Deno.env.get("PRINT_FROM");
  if (!key || !from) {
    await db.from("order_emails").update({ status: "pending", error: "RESEND_API_KEY / CUSTOMER_FROM not set yet (needs a verified domain)" }).eq("order_id", orderId);
    return { error: "email not configured" };
  }
  const { data: rows } = await db.from("inbox").select("payload").eq("kind", "order").filter("payload->order->>id", "eq", orderId).limit(1);
  const o = rows?.[0]?.payload?.order || {};
  // internal sequential number from public.orders (accounts thread); read at mail time, it may lag the inbox insert
  let no = ""; try { const { data: ord } = await db.from("orders").select("order_no").eq("id", orderId).maybeSingle(); if (ord?.order_no) no = String(ord.order_no); } catch (_) { /* table optional */ }
  const ref = no || orderId;
  const first = String(o.customer?.name || "").split(" ")[0];
  const books: string[] = [];
  for (const b of row.books || []) {
    let link = "";
    if (b.pdf) { const { data } = await db.storage.from("orders").createSignedUrl(b.pdf, 60 * 60 * 24 * 30, { download: `${b.title}.pdf` }); link = data?.signedUrl || ""; }
    let clink = "";
    if (b.coloring) { const { data } = await db.storage.from("orders").createSignedUrl(b.coloring, 60 * 60 * 24 * 30, { download: `ספר צביעה - ${b.title}.pdf` }); clink = data?.signedUrl || ""; }
    const gift = b.fmt === "digital" ? "מתנה מאיתנו: ספר צביעה עם הדמות מהספר, להדפסה בבית" : "מתנה מאיתנו: ספרון צביעה מודפס עם הדמות מהספר מגיע בחבילה, והנה הוא גם כ־PDF";
    books.push(`<tr><td style="padding:10px 0;border-bottom:1px solid #eee"><b>${esc(b.title)}</b><br><span style="color:#777">${esc(FMT[b.fmt] || b.fmt)} · כמות ${esc(b.qty || 1)}</span>${link ? `<br><a href="${link}" style="display:inline-block;margin-top:8px;background:#4B3FD8;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:bold">להורדת הספר המלא (PDF)</a>` : `<br><span style="color:#a15c00">קובץ ה־PDF יישלח אליכם בנפרד בקרוב.</span>`}${clink ? `<br><span style="color:#777">${gift}</span><br><a href="${clink}" style="display:inline-block;margin-top:6px;color:#C2553F;font-weight:bold">להורדת ספר הצביעה (PDF)</a>` : ""}</td></tr>`);
  }
  const s = o.shipping || {};
  const ship = s.method && s.method !== "digital" ? `<p><b>משלוח אל:</b> ${esc(o.customer?.name)}, ${esc(s.street)}${s.apt ? ", " + esc(s.apt) : ""}, ${esc(s.city)}</p><p style="color:#777">הספר המודפס יוצא להדפסה ונעדכן אתכם כשהוא נשלח.</p>` : "";
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#2A2540;line-height:1.6">
<h1 style="color:#1A1748;font-size:24px">ההזמנה התקבלה${first ? ", " + esc(first) : ""}!</h1>
<p>מספר הזמנה: <b dir="ltr">${esc(ref)}</b>${no ? ` <span style="color:#999;font-size:12px" dir="ltr">(${esc(orderId)})</span>` : ""}</p>
<table style="width:100%;border-collapse:collapse">${books.join("")}</table>
<p style="margin-top:16px"><b>סה״כ:</b> ${ils(o.total)}${o.payment === "unpaid" ? " (נחזור אליכם להשלמת התשלום)" : ""}</p>
${ship}
<p style="color:#777;font-size:13px">הקישורים להורדה בתוקף 30 יום. שמרו את הקובץ במכשיר. יש שאלה? פשוט השיבו למייל הזה עם מספר ההזמנה.</p>
<p style="color:#1A1748;font-weight:bold">${BRAND}</p></div>`;
  const owner = Deno.env.get("OWNER_EMAIL");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [row.email], bcc: owner ? [owner] : undefined, subject: `אישור הזמנה ${ref} · ${BRAND}`, html }),
  });
  if (!r.ok) {
    const e = (await r.text()).slice(0, 300);
    await db.from("order_emails").update({ status: "failed", error: e }).eq("order_id", orderId);
    return { error: e };
  }
  await db.from("order_emails").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("order_id", orderId);
  return { ok: true };
}

async function buildBook(orderId: string, pid: string) {
  const dir = `${orderId}/${pid}`;
  const cover = await file(`${dir}/print/00.jpg`);
  if (!cover) throw new Error(`missing cover for ${pid}`);
  const coverPdf = await PDFDocument.create();
  coverPdf.setTitle(`${orderId} ${pid} cover`);
  const back = await file(`${dir}/print/13.jpg`); // back cover: the child's photo next to the illustrated character
  const spine = await file(`${dir}/print/14.jpg`);
  const spineMM = await spineMMOf(coverPdf, spine);
  await spread(coverPdf, cover, back, spine, spineMM);
  const inner = await PDFDocument.create();
  inner.setTitle(`${orderId} ${pid} interior`);
  // page 1 stands alone (facing the inside of the cover); then spreads [picture (right) | text (left)]; last page alone
  const open = await file(`${dir}/print/18.jpg`), end = await file(`${dir}/print/19.jpg`);
  if (open) await fill(inner, open);
  for (let i = 1; i <= 12; i++) {
    const art = await file(`${dir}/p${i}.jpg`), text = await file(`${dir}/print/${String(i).padStart(2, "0")}.jpg`);
    if (!art || !text) throw new Error(`missing page ${i} for ${pid}`);
    await fill(inner, art);
    await fill(inner, text);
  }
  if (open) { if (end) await fill(inner, end); else blank(inner); }
  const out: Record<string, any> = { spineMM };
  out.book = await buildReader(orderId, pid);
  for (const [name, doc] of [["cover", coverPdf], ["interior", inner]] as const) {
    const bytes = await doc.save();
    const path = `${dir}/${name}.pdf`;
    const { error } = await db.storage.from("orders").upload(path, new Blob([bytes], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
    if (error) throw new Error(`upload ${name}: ${error.message}`);
    out[name] = path;
  }
  return out;
}

async function sendToPrinter(orderId: string) {
  const { data: job } = await db.from("print_jobs").select("*").eq("order_id", orderId).maybeSingle();
  if (!job) return { error: "no such job" };
  if (job.status !== "approved") return { error: `status is ${job.status}, not approved` };
  const to = Deno.env.get("PRINT_EMAIL"), key = Deno.env.get("RESEND_API_KEY");
  if (!to || !key) {
    await db.from("print_jobs").update({ status: "failed", error: "PRINT_EMAIL / RESEND_API_KEY not set yet" }).eq("order_id", orderId);
    return { error: "email not configured" };
  }
  const lines: string[] = [];
  for (const b of job.books || []) {
    const links: string[] = [];
    for (const k of ["cover", "interior"]) {
      const { data } = await db.storage.from("orders").createSignedUrl(b.pdf[k], 60 * 60 * 24 * 14);
      links.push(`${k === "cover" ? `כריכה (פריסה אחת: קדמית משמאל | שדרה ${b.pdf.spineMM ?? SPINE_DEFAULT} מ"מ | אחורית מימין)` : "פנים הספר (26 עמודים: עמוד פתיחה, 12 זוגות תמונה וטקסט, עמוד סיום)"}: ${data?.signedUrl}`);
    }
    if (b.coloring?.cover && b.coloring?.interior) {
      for (const k of ["cover", "interior"]) {
        const { data } = await db.storage.from("orders").createSignedUrl(b.coloring[k], 60 * 60 * 24 * 14);
        links.push(`ספרון צביעה, ${k === "cover" ? "כריכה רכה (פריסה: קדמית משמאל | אחורית מימין, בלי שדרה)" : "פנים (12 עמודים, סיכות)"}: ${data?.signedUrl}`);
      }
    } else links.push("ספרון צביעה: עוד בהכנה, יישלח בנפרד");
    lines.push(`ספר: ${b.title}\nכריכה: ${b.format} · כמות: ${b.qty} (+ ספרון צביעה אחד לכל ספר)\n${links.join("\n")}`);
  }
  const c = job.customer || {};
  const text = `הזמנה ${orderId}\n\n${lines.join("\n\n")}\n\nמשלוח: ${c.name || ""}, ${c.street || ""} ${c.apt || ""}, ${c.city || ""} ${c.zip || ""} · טלפון ${c.phone || ""}\nהערה: ${c.note || "-"}\n\nמפרט: ספר ${TRIM_W}x${TRIM_H} מ"מ כריכה קשה, ספרון צביעה ${TRIM_W}x${TRIM_H} מ"מ כריכה רכה. בליד ${BLEED} מ"מ מכל צד, 300dpi. ספר עברי: נפתח מימין. הקישורים בתוקף 14 יום.`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("PRINT_FROM") || `${BRAND} <onboarding@resend.dev>`, to: [to], cc: Deno.env.get("PRINT_CC") ? [Deno.env.get("PRINT_CC")] : undefined, subject: `הזמנת הדפסה ${orderId}`, text }),
  });
  if (!r.ok) {
    const e = (await r.text()).slice(0, 300);
    await db.from("print_jobs").update({ status: "failed", error: `email: ${e}` }).eq("order_id", orderId);
    return { error: e };
  }
  await db.from("print_jobs").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("order_id", orderId);
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const orderId = String(body.orderId || "");
  if (!/^LM-[A-Z0-9]{4,10}$/.test(orderId)) return json({ error: "Bad order id" }, 400);
  try {
    if (body.action === "send") return json(await sendToPrinter(orderId));
    if (body.action === "mail") return json(await mailCustomer(orderId));
    if (body.action === "coloring") return json(await coloringJob(orderId));
    // build: the order row (sent by the site) is the source of truth for titles, formats and address
    const { data: existing } = await db.from("print_jobs").select("order_id,status").eq("order_id", orderId).maybeSingle();
    if (existing && existing.status !== "ready") return json({ ok: true, status: existing.status, mail: await mailCustomer(orderId) });
    const { data: rows } = await db.from("inbox").select("payload").eq("kind", "order").filter("payload->order->>id", "eq", orderId).limit(1);
    const order = rows?.[0]?.payload?.order;
    if (!order) return json({ error: "order not found" }, 404);
    const books: any[] = [], mailBooks: any[] = [];
    for (const it of order.items || []) {
      const pid = (it.files || [])[0]?.split("/")[2];
      if (!pid) continue;
      if (it.fmt === "digital") { // not printed: only the family PDF
        let pdf: string | null = null; try { pdf = await buildReader(orderId, pid); } catch (e) { console.warn(e); }
        mailBooks.push({ project: pid, title: it.title, fmt: it.fmt, qty: it.qty, pdf });
        continue;
      }
      const pdf = await buildBook(orderId, pid);
      books.push({ project: pid, title: it.title, format: it.fmt, qty: it.qty, pdf });
      mailBooks.push({ project: pid, title: it.title, fmt: it.fmt, qty: it.qty, pdf: pdf.book });
    }
    if (order.customer?.email && mailBooks.length) {
      const { data: had } = await db.from("order_emails").select("status").eq("order_id", orderId).maybeSingle();
      if (!had) await db.from("order_emails").insert({ order_id: orderId, email: order.customer.email, books: mailBooks });
    }
    if (books.length) {
      const s = order.shipping || {};
      await db.from("print_jobs").upsert({ order_id: orderId, status: "ready", books, customer: { name: order.customer?.name, phone: order.customer?.phone, email: order.customer?.email, city: s.city, street: s.street, apt: s.apt, zip: s.zip, note: s.note, method: s.method } });
    }
    // the coloring booklet (about a minute) and then the customer email run after the response
    const bg = coloringJob(orderId).catch((e) => console.warn("coloring job", e));
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(bg);
    return json({ ok: true, books: books.length, coloring: "started" });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
