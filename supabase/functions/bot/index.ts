// Shared 24/7 paper-trading bot + personal 24/7 bots. Called every minute by pg_cron (see supabase/cron.sql).
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

// ---------- shared bot ----------
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
  return { scanned: Object.keys(klines).length, signals: rows.filter((r) => M.wants(r, S)).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length, ticker: undefined as any };
}

// ---------- personal bots (one per browser; config = profiles chosen on the site) ----------
const PROFILE_DEF = { method: "log", N: 210, k: 3, tf: "15m", minScore: 60, strategy: "revert", rr: 0, risk: 0.02, lev: 1, minWidth: 0, maxHL: 0, longOnly: false, coinErMax: 0 };
const tfOf = (ms: number) => Object.keys(M.TFMS).find((k) => (M.TFMS as any)[k] === ms);
const effN = (len: number, S: any) => (S.tf === "1d" || S.tf === "1w") ? Math.max(20, Math.min(S.N, len - 20)) : S.N;
// market regime the same way the site does it: BTC/ETH/SOL on 1h, efficiency ratio over 7 days
async function majorsRegime() {
  const got: Record<string, any> = {};
  await Promise.all(M.MAJORS.map(async (s: string) => {
    try {
      const c = (await api(`/api/v3/klines?symbol=${s}&interval=1h&limit=200`)).map((k: any) => +k[4]), L = 168, i = c.length - 1;
      let path = 0; for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
      got[s] = { er: path ? Math.abs(c[i] - c[i - L]) / path : 0, ch: c[i] / c[i - L] - 1 };
    } catch { /* regime falls back to BTC-only or null */ }
  }));
  const m: any = M.marketOf((s: string) => got[s] || null);
  if (m) m.by = got;
  return m;
}
async function runUserBots(now: number) {
  const { data: bots } = await db.from("user_bots").select("id, config, balance").eq("enabled", true).order("created_at").limit(40);
  if (!bots?.length) return 0;
  const reg = await majorsRegime(), ticker = await api("/api/v3/ticker/24hr");
  const kc = new Map<string, Promise<any>>();   // one download per coin + timeframe for all bots
  const getK = (s: string, tf: string) => { const key = s + "|" + tf; if (!kc.has(key)) kc.set(key, api(`/api/v3/klines?symbol=${s}&interval=${tf}&limit=450`).catch(() => null)); return kc.get(key)!; };
  let done = 0;
  for (const b of bots) {
    try {
      const cfg = b.config || {}, profiles = cfg.profiles || [];
      if (!profiles.length) continue;
      const byId = (id: string) => profiles.find((p: any) => p.id === id) || profiles[0];
      const regName = M.regimeOf(reg, { erMax: cfg.erMax ?? 0.15, regimeSrc: "majors" });
      const P = cfg.mode === "auto" ? byId(regName === "flat" ? cfg.flat : cfg.impulse) : byId(cfg.active);
      const S = { ...PROFILE_DEF, ...P.set, regimeSrc: "majors", erMax: cfg.erMax ?? 0.15 };
      const list: string[] = P.coins?.mode === "list" ? P.coins.list.slice(0, 200) : M.pickSymbols(ticker, Math.min(P.coins?.top || 150, 200), [], now);
      const { data: pr } = await db.from("user_positions").select("data").eq("bot_id", b.id);
      const open = (pr ?? []).map((x: any) => x.data);
      const Ks: Record<string, any> = {};
      await pool(list, 10, async (s) => { Ks[s] = await getK(s, S.tf); });
      const rows = list.map((s) => Ks[s]?.length ? M.analyze(s, Ks[s], { ...S, N: effN(Ks[s].length, S) }, now) : null).filter(Boolean);
      const exitK: Record<string, any> = {};
      for (const p of open) exitK[p.sym] = await getK(p.sym, tfOf(p.tfms) || S.tf);
      const { data: rec } = await db.from("user_trades").select("data").eq("bot_id", b.id).gt("tclose", now - M.COOLDOWN * (M.TFMS as any)[S.tf]);
      const res = M.botTick({ rows, klines: exitK, open, recentSyms: (rec ?? []).map((x: any) => x.data.sym), balance: b.balance, S, now, market: reg });
      for (const p of res.opened) { p.note = `«${P.name}» · ${p.note}`; p.snap.profile = P.name; }
      if (res.closed.length) {
        await db.from("user_trades").insert(res.closed.map((t: any) => ({ bot_id: b.id, id: t.id, tclose: t.tclose, data: t })));
        await db.from("user_positions").delete().eq("bot_id", b.id).in("id", res.closed.map((t: any) => t.id));
      }
      const keep = [...res.stillOpen, ...res.opened];
      if (keep.length) await db.from("user_positions").upsert(keep.map((p: any) => ({ bot_id: b.id, id: p.id, data: p })));
      await db.from("user_bots").update({ balance: res.balance, checked_at: new Date(now).toISOString(), active_profile: P.name,
        regime: reg ? { state: regName, by: reg.by } : null, last_error: null }).eq("id", b.id);
      done++;
    } catch (e) {
      await db.from("user_bots").update({ last_error: String((e as Error)?.message ?? e), checked_at: new Date(now).toISOString() }).eq("id", b.id);
    }
  }
  return done;
}

Deno.serve(async (req) => {
  const { data: sec } = await db.from("bot_secret").select("token").eq("id", 1).single();
  if (!sec || req.headers.get("x-bot-token") !== sec.token) return new Response("forbidden", { status: 403 });
  const { data: locked } = await db.rpc("bot_try_lock", { seconds: 120 });
  if (!locked) return Response.json({ skipped: "another run in progress" });
  const t0 = Date.now();
  try {
    const out = await run();
    let users = 0;
    try { users = await runUserBots(Date.now()); } catch { /* personal bots never break the shared one */ }
    await db.from("bot_runs").insert({ ok: true, ms: Date.now() - t0, scanned: out.scanned, signals: out.signals, opened: out.opened, closed: out.closed });
    return Response.json({ ...out, users });
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
