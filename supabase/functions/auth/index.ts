// Sign-in through the Telegram bot (docs/PLAN-ACCOUNTS.md). Deployed without JWT checks: the caller isn't signed in yet.
//   {op:"start", h}            h = sha256 hex of a secret only the tab knows → {nonce, code, bot}
//   {op:"poll", nonce, secret} → {state: "wait" | "denied" | "expired" | "ok", token_hash?}
//   {op:"delete"} with the person's access token → the profile and everything synced to it are deleted
// The tab opens t.me/<bot>?start=login_<nonce>; the bot asks to pick the code shown on the site (_shared/tg.ts) and fills
// tg_id. A poll with the right secret then gets a one-time magic-link token hash, which the tab trades for a session at
// /auth/v1/verify. Someone who sends a victim their own login link gains nothing: the victim's tab never shows that code,
// and the session goes only to the tab that holds the secret.
import { createClient } from "npm:@supabase/supabase-js@2";
import { LOGIN_EMOJI, LOGIN_TTL } from "../_shared/login.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// the emoji and the request's lifetime are shared with the bot's buttons (_shared/login.ts)
const TTL = LOGIN_TTL, EMOJI = LOGIN_EMOJI, MAX_STARTS = 10, MAX_POLLS = 200;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, apikey, authorization", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

let botName = "", botAt = 0;
async function bot() {
  if (Date.now() - botAt > 10 * 60e3) { const { data } = await db.from("tg_config").select("bot_name").eq("id", 1).maybeSingle(); botName = data?.bot_name || ""; botAt = Date.now(); }
  return botName;
}

async function start(b: any, ip: string) {
  if (!/^[0-9a-f]{64}$/.test(String(b.h || ""))) return json({ error: "bad request" }, 400);
  const since = new Date(Date.now() - 10 * 60e3).toISOString();
  const { count } = await db.from("login_requests").select("nonce", { count: "exact", head: true }).eq("ip", ip).gt("created_at", since);
  if ((count || 0) >= MAX_STARTS) return json({ error: "too many" }, 429);
  // old requests are of no use to anyone: a day is kept for looking into problems
  await db.from("login_requests").delete().lt("created_at", new Date(Date.now() - 864e5).toISOString());
  const nonce = hex(rnd(16).buffer), r = rnd(2), code = EMOJI[r[0] % 16] + EMOJI[(r[0] % 16 + 1 + r[1] % 15) % 16];   // two different emoji
  const { error } = await db.from("login_requests").insert({ nonce, secret_hash: b.h, code, ip });
  if (error) return json({ error: "db" }, 500);
  return json({ nonce, code, bot: await bot(), ttl: TTL });
}

async function poll(b: any) {
  const nonce = String(b.nonce || ""), secret = String(b.secret || "");
  if (!/^[0-9a-f]{32}$/.test(nonce) || secret.length < 32) return json({ error: "bad request" }, 400);
  const { data: q } = await db.from("login_requests").select("*").eq("nonce", nonce).maybeSingle();
  if (!q || q.secret_hash !== await sha256(secret)) return json({ state: "expired" });
  if (q.used_at || q.polls >= MAX_POLLS || Date.now() - Date.parse(q.created_at) > TTL + 60e3) return json({ state: "expired" });
  if (q.denied_at) return json({ state: "denied" });
  await db.from("login_requests").update({ polls: q.polls + 1 }).eq("nonce", nonce);
  if (!q.confirmed_at || !q.tg_id) return json({ state: "wait" });
  // one session per request: whoever marks it used first gets the token
  const { data: took } = await db.from("login_requests").update({ used_at: new Date().toISOString() }).eq("nonce", nonce).is("used_at", null).select("nonce");
  if (!took?.length) return json({ state: "expired" });
  const email = `tg${q.tg_id}@users.invalid`;
  let { data: p } = await db.from("profiles").select("id").eq("tg_id", q.tg_id).maybeSingle();
  if (!p) {
    const { data: u } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { tg_id: q.tg_id } });
    let uid = u?.user?.id;
    // the Auth user can exist without a profile (an earlier sign-in stopped between the two): find it through its link
    if (!uid) { const { data: l } = await db.auth.admin.generateLink({ type: "magiclink", email }); uid = l?.user?.id; }
    if (!uid) return json({ error: "user" }, 500);
    const { error: e2 } = await db.from("profiles").upsert({ id: uid, tg_id: q.tg_id, tg_name: q.tg_name, tg_username: q.tg_username });
    if (e2) return json({ error: "profile" }, 500);
  } else await db.from("profiles").update({ tg_name: q.tg_name, tg_username: q.tg_username, seen_at: new Date().toISOString() }).eq("id", p.id);
  const { data: link, error: e3 } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (e3 || !link?.properties?.hashed_token) return json({ error: "link: " + (e3?.message || "?") }, 500);
  return json({ state: "ok", token_hash: link.properties.hashed_token });
}

// the signed-in person deletes their profile: the Auth user goes, and with it (on delete cascade) the profile and synced settings
async function remove(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return json({ error: "not signed in" }, 401);
  const { error: e2 } = await db.auth.admin.deleteUser(data.user.id);
  return e2 ? json({ error: "delete: " + e2.message }, 500) : json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b: any; try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim().slice(0, 64) || "?";
  try {
    if (b?.op === "start") return await start(b, ip);
    if (b?.op === "poll") return await poll(b);
    if (b?.op === "delete") return await remove(req);
  } catch (e) { return json({ error: String((e as Error)?.message || e).slice(0, 200) }, 500); }
  return json({ error: "unknown op" }, 400);
});
