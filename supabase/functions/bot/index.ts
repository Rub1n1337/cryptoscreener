// Shared 24/7 paper-trading bot. Called every minute by pg_cron (see supabase/cron.sql).
// All strategy math lives in ../_shared/math.js — the same file the site uses.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as M from "../_shared/math.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];

async function api(path: string) {
  let err: unknown;
  for (const b of BASES) {
    try { const r = await fetch(b + path); if (r.ok) return await r.json(); err = new Error("HTTP " + r.status + " " + b); } catch (e) { err = e; }
  }
  throw err;
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function run() {
  const now = Date.now();
  const { data: st, error: e1 } = await db.from("bot_state").select("*").eq("id", 1).single();
  if (e1) throw e1;
  const S = st.settings;
  const { data: open, error: e2 } = await db.from("positions").select("*");
  if (e2) throw e2;
  const list = M.pickSymbols(await api("/api/v3/ticker/24hr"), S.top, open!.map((p: any) => p.sym), now);

  const klines: Record<string, unknown[]> = {}, rows: any[] = [];
  const limit = Math.min(1000, S.N + 150);
  await pool(list, 10, async (sym) => {
    try { const K = await api(`/api/v3/klines?symbol=${sym}&interval=${S.tf}&limit=${limit}`); klines[sym] = K; const r = M.analyze(sym, K, S, now); if (r) rows.push(r); } catch { /* skip pair */ }
  });

  const { data: recent } = await db.from("trades").select("sym").gt("tclose", now - M.COOLDOWN * M.TFMS[S.tf]);
  const res = M.botTick({ rows, klines, open: open!, recentSyms: (recent ?? []).map((x: any) => x.sym), balance: st.balance, S, now });

  if (res.closed.length) {
    const { error } = await db.from("trades").insert(res.closed); if (error) throw error;
    const { error: e3 } = await db.from("positions").delete().in("id", res.closed.map((x: any) => x.id)); if (e3) throw e3;
  }
  const upserts = [...res.stillOpen, ...res.opened];
  if (upserts.length) { const { error } = await db.from("positions").upsert(upserts); if (error) throw error; }
  await db.from("bot_state").update({ balance: res.balance, checked_at: new Date(now).toISOString(), scanned: Object.keys(klines).length, last_error: null }).eq("id", 1);
  return { scanned: Object.keys(klines).length, signals: rows.filter((r) => r.rev).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length };
}

Deno.serve(async (req) => {
  const { data: sec } = await db.from("bot_secret").select("token").eq("id", 1).single();
  if (!sec || req.headers.get("x-bot-token") !== sec.token) return new Response("forbidden", { status: 403 });
  const { data: locked } = await db.rpc("bot_try_lock", { seconds: 120 });
  if (!locked) return Response.json({ skipped: "another run in progress" });
  try {
    return Response.json(await run());
  } catch (e) {
    await db.from("bot_state").update({ last_error: String((e as Error)?.message ?? e), checked_at: new Date().toISOString() }).eq("id", 1);
    return Response.json({ error: String(e) }, { status: 500 });
  } finally {
    await db.from("bot_state").update({ lock_until: null }).eq("id", 1);
  }
});
