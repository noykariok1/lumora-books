// Deletes the signed-in parent's account: saved characters (rows + drawings in the private
// "characters" bucket) and the login itself. Orders are kept for accounting/tax records,
// but are detached from the account (orders.user_id -> null via FK on delete set null).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "not signed in" }, 401);
  const uid = u.user.id;
  let body: { confirm?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  if (body.confirm !== "DELETE") return json({ error: "confirm" }, 400);

  // 1. drawings in the private bucket (folder = user id)
  let removed = 0;
  for (;;) {
    const { data: files, error } = await admin.storage.from("characters").list(uid, { limit: 100 });
    if (error) return json({ error: "storage list" }, 500);
    if (!files?.length) break;
    const { error: re } = await admin.storage.from("characters").remove(files.map((f) => `${uid}/${f.name}`));
    if (re) return json({ error: "storage remove" }, 500);
    removed += files.length;
    if (files.length < 100) break;
  }
  // 2. character rows (also cascade from auth.users, done explicitly to be safe)
  await admin.from("characters").delete().eq("user_id", uid);
  // 3. keep orders, detach them
  await admin.from("orders").update({ user_id: null }).eq("user_id", uid);
  // 4. the login
  const { error: de } = await admin.auth.admin.deleteUser(uid);
  if (de) return json({ error: "delete user" }, 500);
  return json({ ok: true, files: removed });
});
