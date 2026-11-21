// Agadibook: build print-ready PDFs for an order and send them to the printer (Bari print).
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   PRINT_EMAIL      the printer's order inbox (required to send)
//   RESEND_API_KEY   email sending via resend.com (required to send; needs a verified sender domain)
//   PRINT_FROM       optional sender, e.g. "Lumora <orders@your-domain.co.il>"
//   PRINT_CC         optional copy to the owner
//   CUSTOMER_FROM    sender of the customer emails, e.g. "אגדיבוק <orders@your-domain.co.il>" (falls back to PRINT_FROM)
//   OWNER_EMAIL      optional: gets a copy (bcc) of every customer email
// Customer email: right after "build", every customer gets an order confirmation with the order number and a
// download link to the full book as a PDF (hardcover and digital alike). Rows in table order_emails; while the
// sender domain is not verified the row stays "pending"/"failed" and { action: "mail", orderId } sends it again.
// Book spec (change with the printer's real spec): trim 210x250 mm, 3 mm bleed, 300 dpi images.
// Requests (POST JSON):
//   { action: "build", orderId }  called by the site right after the order files are uploaded
//   { action: "send",  orderId }  called by the database when print_jobs.status becomes 'approved'
//                                 (later: by the payment webhook). Sends only if the row really is approved.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { PDFDocument } from "npm:pdf-lib@1.17.1";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const MM = 72 / 25.4, TRIM_W = 210, TRIM_H = 250, BLEED = 3;
const PW = (TRIM_W + 2 * BLEED) * MM, PH = (TRIM_H + 2 * BLEED) * MM;
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
async function fill(pdf: PDFDocument, bytes: Uint8Array) { // cover-fit an image over the full bleed area
  const img = await pdf.embedJpg(bytes);
  const s = Math.max(PW / img.width, PH / img.height);
  const w = img.width * s, h = img.height * s;
  page(pdf).drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
}

// the full book as one PDF for the family: front cover, 12 picture + text spreads, back cover
async function buildReader(orderId: string, pid: string) {
  const dir = `${orderId}/${pid}`;
  const doc = await PDFDocument.create();
  doc.setTitle("אגדיבוק");
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
  const first = String(o.customer?.name || "").split(" ")[0];
  const books: string[] = [];
  for (const b of row.books || []) {
    let link = "";
    if (b.pdf) { const { data } = await db.storage.from("orders").createSignedUrl(b.pdf, 60 * 60 * 24 * 30, { download: `${b.title}.pdf` }); link = data?.signedUrl || ""; }
    books.push(`<tr><td style="padding:10px 0;border-bottom:1px solid #eee"><b>${esc(b.title)}</b><br><span style="color:#777">${esc(FMT[b.fmt] || b.fmt)} · כמות ${esc(b.qty || 1)}</span>${link ? `<br><a href="${link}" style="display:inline-block;margin-top:8px;background:#4B3FD8;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:bold">להורדת הספר המלא (PDF)</a>` : `<br><span style="color:#a15c00">קובץ ה־PDF יישלח אליכם בנפרד בקרוב.</span>`}</td></tr>`);
  }
  const s = o.shipping || {};
  const ship = s.method && s.method !== "digital" ? `<p><b>משלוח אל:</b> ${esc(o.customer?.name)}, ${esc(s.street)}${s.apt ? ", " + esc(s.apt) : ""}, ${esc(s.city)}</p><p style="color:#777">הספר המודפס יוצא להדפסה ונעדכן אתכם כשהוא נשלח.</p>` : "";
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#2A2540;line-height:1.6">
<h1 style="color:#1A1748;font-size:24px">ההזמנה התקבלה${first ? ", " + esc(first) : ""}!</h1>
<p>מספר הזמנה: <b dir="ltr">${esc(orderId)}</b></p>
<table style="width:100%;border-collapse:collapse">${books.join("")}</table>
<p style="margin-top:16px"><b>סה״כ:</b> ${ils(o.total)}${o.payment === "unpaid" ? " (נחזור אליכם להשלמת התשלום)" : ""}</p>
${ship}
<p style="color:#777;font-size:13px">הקישורים להורדה בתוקף 30 יום. שמרו את הקובץ במכשיר. יש שאלה? פשוט השיבו למייל הזה עם מספר ההזמנה.</p>
<p style="color:#1A1748;font-weight:bold">אגדיבוק</p></div>`;
  const owner = Deno.env.get("OWNER_EMAIL");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [row.email], bcc: owner ? [owner] : undefined, subject: `אישור הזמנה ${orderId} · אגדיבוק`, html }),
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
  await fill(coverPdf, cover);
  const back = await file(`${dir}/print/13.jpg`); // back cover: the child's photo next to the illustrated character
  if (back) await fill(coverPdf, back);
  const inner = await PDFDocument.create();
  inner.setTitle(`${orderId} ${pid} interior`);
  for (let i = 1; i <= 12; i++) {
    const art = await file(`${dir}/p${i}.jpg`), text = await file(`${dir}/print/${String(i).padStart(2, "0")}.jpg`);
    if (!art || !text) throw new Error(`missing page ${i} for ${pid}`);
    await fill(inner, art);
    await fill(inner, text);
  }
  const out: Record<string, string> = {};
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
      links.push(`${k === "cover" ? "כריכה" : "פנים הספר"}: ${data?.signedUrl}`);
    }
    lines.push(`ספר: ${b.title}\nכריכה: ${b.format} · כמות: ${b.qty}\n${links.join("\n")}`);
  }
  const c = job.customer || {};
  const text = `הזמנה ${orderId}\n\n${lines.join("\n\n")}\n\nמשלוח: ${c.name || ""}, ${c.street || ""} ${c.apt || ""}, ${c.city || ""} ${c.zip || ""} · טלפון ${c.phone || ""}\nהערה: ${c.note || "-"}\n\nמפרט: ${TRIM_W}x${TRIM_H} מ"מ, בליד ${BLEED} מ"מ מכל צד. הקישורים בתוקף 14 יום.`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("PRINT_FROM") || "Agadibook <onboarding@resend.dev>", to: [to], cc: Deno.env.get("PRINT_CC") ? [Deno.env.get("PRINT_CC")] : undefined, subject: `הזמנת הדפסה ${orderId}`, text }),
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
        mailBooks.push({ title: it.title, fmt: it.fmt, qty: it.qty, pdf });
        continue;
      }
      const pdf = await buildBook(orderId, pid);
      books.push({ project: pid, title: it.title, format: it.fmt, qty: it.qty, pdf });
      mailBooks.push({ title: it.title, fmt: it.fmt, qty: it.qty, pdf: pdf.book });
    }
    let mail: unknown = null;
    if (order.customer?.email && mailBooks.length) {
      const { data: had } = await db.from("order_emails").select("status").eq("order_id", orderId).maybeSingle();
      if (!had) await db.from("order_emails").insert({ order_id: orderId, email: order.customer.email, books: mailBooks });
      mail = await mailCustomer(orderId);
    }
    if (!books.length) return json({ ok: true, books: 0, mail });
    const s = order.shipping || {};
    await db.from("print_jobs").upsert({ order_id: orderId, status: "ready", books, customer: { name: order.customer?.name, phone: order.customer?.phone, email: order.customer?.email, city: s.city, street: s.street, apt: s.apt, zip: s.zip, note: s.note, method: s.method } });
    return json({ ok: true, books: books.length, mail });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
