// Agadibook: build print-ready PDFs for an order and send them to the printer (Bari print).
// Secrets (Supabase dashboard > Edge Functions > Secrets):
//   PRINT_EMAIL      the printer's order inbox (required to send)
//   RESEND_API_KEY   email sending via resend.com (required to send; needs a verified sender domain)
//   PRINT_FROM       optional sender, e.g. "Lumora <orders@your-domain.co.il>"
//   PRINT_CC         optional copy to the owner
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
    // build: the order row (sent by the site) is the source of truth for titles, formats and address
    const { data: existing } = await db.from("print_jobs").select("order_id,status").eq("order_id", orderId).maybeSingle();
    if (existing && existing.status !== "ready") return json({ ok: true, status: existing.status });
    const { data: rows } = await db.from("inbox").select("payload").eq("kind", "order").filter("payload->order->>id", "eq", orderId).limit(1);
    const order = rows?.[0]?.payload?.order;
    if (!order) return json({ error: "order not found" }, 404);
    const books = [];
    for (const it of order.items || []) {
      const pid = (it.files || [])[0]?.split("/")[2];
      if (!pid || it.fmt === "digital") continue; // digital books are not printed
      books.push({ project: pid, title: it.title, format: it.fmt, qty: it.qty, pdf: await buildBook(orderId, pid) });
    }
    if (!books.length) return json({ error: "no personal books in order" }, 400);
    const s = order.shipping || {};
    await db.from("print_jobs").upsert({ order_id: orderId, status: "ready", books, customer: { name: order.customer?.name, phone: order.customer?.phone, email: order.customer?.email, city: s.city, street: s.street, apt: s.apt, zip: s.zip, note: s.note, method: s.method } });
    return json({ ok: true, books: books.length });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
