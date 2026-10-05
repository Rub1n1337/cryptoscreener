// Shared 24/7 paper-trading bot. Called every minute by pg_cron (see supabase/cron.sql).
// All strategy math lives in ../_shared/math.js — the same file the site uses.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as M from "../_shared/math.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
const SITE = "https://cryptoscreener-topaz.vercel.app";

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

// ---------- Telegram (optional: configured in public.tg_config, see README) ----------
const fp = (p: number) => { const a = Math.abs(p); return "$" + (a >= 1000 ? p.toFixed(0) : a >= 100 ? p.toFixed(2) : a >= 1 ? p.toFixed(3) : p.toPrecision(4)); };
const pct = (v: number, e: number) => { const x = (v / e - 1) * 100; return (x > 0 ? "+" : "−") + Math.abs(x).toFixed(2) + "%"; };
const pair = (s: string) => s.replace(/USDT$/, "/USDT");
async function notify(lines: string[]) {
  if (!lines.length) return;
  const { data: tg } = await db.from("tg_config").select("enabled, bot_token, chat_id").eq("id", 1).maybeSingle();
  if (!tg?.enabled || !tg.bot_token || !tg.chat_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat_id, text: lines.join("\n\n") + `\n\n<a href="${SITE}">Sigma Radar</a> · бумажная торговля`, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch { /* notifications must never break trading */ }
}
const openedMsg = (p: any) =>
  `${p.side === "LONG" ? "🟢" : "🔴"} <b>${p.side} ${pair(p.sym)}</b> — общий бот открыл позицию\n` +
  `вход ${fp(p.entry)} · тейк ${fp(p.tp)} (${pct(p.tp, p.entry)}) · стоп ${fp(p.sl)} (${pct(p.sl, p.entry)})\n` +
  `сила сигнала ${p.snap?.score ?? "—"} · риск $${p.risk.toFixed(2)}`;
const closedMsg = (t: any) =>
  `${t.pnl > 0 ? "✅" : "❌"} <b>${pair(t.sym)} ${t.side}</b> закрыта: ${t.reason}\n` +
  `${fp(t.entry)} → ${fp(t.exit)} · PnL ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.r >= 0 ? "+" : "−"}${Math.abs(t.r).toFixed(2)}R) · комиссия $${t.fee.toFixed(2)}`;

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
  await notify([...res.closed.map(closedMsg), ...res.opened.map(openedMsg)]);
  return { scanned: Object.keys(klines).length, signals: rows.filter((r) => M.wants(r, S)).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length };
}

Deno.serve(async (req) => {
  const { data: sec } = await db.from("bot_secret").select("token").eq("id", 1).single();
  if (!sec || req.headers.get("x-bot-token") !== sec.token) return new Response("forbidden", { status: 403 });
  const { data: locked } = await db.rpc("bot_try_lock", { seconds: 120 });
  if (!locked) return Response.json({ skipped: "another run in progress" });
  const t0 = Date.now();
  try {
    const out = await run();
    await db.from("bot_runs").insert({ ok: true, ms: Date.now() - t0, ...out, open: undefined });
    return Response.json(out);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await db.from("bot_state").update({ last_error: msg, checked_at: new Date().toISOString() }).eq("id", 1);
    // alert only on the first failure in a row, not every minute
    const { data: prev } = await db.from("bot_runs").select("ok").order("ts", { ascending: false }).limit(1);
    await db.from("bot_runs").insert({ ok: false, ms: Date.now() - t0, error: msg });
    if (prev?.[0]?.ok !== false) await notify([`⚠️ <b>Общий бот: ошибка</b>\n${msg}`]);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    await db.from("bot_runs").delete().lt("ts", new Date(Date.now() - 3 * 864e5).toISOString());
    await db.from("bot_state").update({ lock_until: null }).eq("id", 1);
  }
});
