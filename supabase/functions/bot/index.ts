// Shared 24/7 paper-trading bot. Called every minute by pg_cron (see supabase/cron.sql).
// The math mirrors index.html: same channel models, signal confirmation, score and trade rules.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TFMS: Record<string, number> = { "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 144e5 };
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
const STABLE = new Set(["USDC","FDUSD","TUSD","BUSD","DAI","USDP","AEUR","EUR","EURI","USDE","USD1","BFUSD","XUSD","PYUSD","RLUSD","UST","USTC","SUSD"]);
const FEE = 0.00075;

type Settings = { method: string; N: number; k: number; tf: string; top: number; minScore: number };
type K = [number, string, string, string, string, string, ...unknown[]];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

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

// ---------- math (same as index.html) ----------
function bands(c: number[], N: number, k: number, m: string): { mid: number[]; up: number[]; lo: number[]; z: number[] } {
  const n = c.length, mid = Array(n).fill(NaN), up = Array(n).fill(NaN), lo = Array(n).fill(NaN), z = Array(n).fill(NaN);
  if (m === "log") {
    const r = bands(c.map(Math.log), N, k, "classic");
    return { mid: r.mid.map(Math.exp), up: r.up.map(Math.exp), lo: r.lo.map(Math.exp), z: r.z };
  }
  if (m === "ewma") {
    const a = 2 / (N + 1); let mu = c[0], v = 0;
    for (let i = 0; i < n; i++) {
      const d = c[i] - mu; mu += a * d; v = (1 - a) * (v + a * d * d);
      if (i >= N - 1) { const s = Math.sqrt(v); mid[i] = mu; up[i] = mu + k * s; lo[i] = mu - k * s; z[i] = s ? (c[i] - mu) / s : 0; }
    }
    return { mid, up, lo, z };
  }
  for (let i = N - 1; i < n; i++) {
    const w = c.slice(i - N + 1, i + 1); let mu: number, s: number;
    if (m === "robust") { mu = median(w); s = 1.4826 * median(w.map((x) => Math.abs(x - mu))); }
    else { mu = w.reduce((p, x) => p + x, 0) / N; s = Math.sqrt(w.reduce((p, x) => p + (x - mu) ** 2, 0) / N); }
    mid[i] = mu; up[i] = mu + k * s; lo[i] = mu - k * s; z[i] = s ? (c[i] - mu) / s : 0;
  }
  return { mid, up, lo, z };
}
function rsi(c: number[], p = 14) {
  const r = Array(c.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], G = Math.max(d, 0), L = Math.max(-d, 0);
    if (i <= p) { g += G; l += L; if (i === p) { g /= p; l /= p; r[i] = l ? 100 - 100 / (1 + g / l) : 100; } }
    else { g = (g * (p - 1) + G) / p; l = (l * (p - 1) + L) / p; r[i] = l ? 100 - 100 / (1 + g / l) : 100; }
  }
  return r;
}
function atr(h: number[], l: number[], c: number[], p = 14) {
  let a = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    a = i <= p ? (isNaN(a) ? tr : a + (tr - a) / i) : (a * (p - 1) + tr) / p;
  }
  return a;
}
function halfLife(c: number[], mid: number[]) {
  const x: number[] = []; for (let i = 0; i < c.length; i++) if (isFinite(mid[i]) && mid[i] > 0) x.push(Math.log(c[i]) - Math.log(mid[i]));
  const xs = x.slice(-150); let num = 0, den = 0;
  for (let i = 1; i < xs.length; i++) { num += xs[i] * xs[i - 1]; den += xs[i - 1] * xs[i - 1]; }
  const phi = den ? num / den : 1;
  return phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : Infinity;
}
function analyze(sym: string, Kl: K[], S: Settings) {
  const t = Kl.map((x) => x[0]), o = Kl.map((x) => +x[1]), h = Kl.map((x) => +x[2]), l = Kl.map((x) => +x[3]), c = Kl.map((x) => +x[4]), v = Kl.map((x) => +x[5]);
  const n = c.length, i = n - 1, p = n - 2;
  if (n < S.N + 10) return null;
  const B = bands(c, S.N, S.k, S.method);
  if (!isFinite(B.mid[i]) || B.up[i] <= B.lo[i]) return null;
  const r = rsi(c)[i], hl = halfLife(c, B.mid);
  const elapsed = clamp((Date.now() - t[i]) / TFMS[S.tf], 0.25, 1);
  const va = v.slice(); va[i] = v[i] / elapsed;
  const baseV = v.slice(Math.max(0, n - 100), n - 4).filter((x) => x > 0).map(Math.log);
  const vm = median(baseV), vmad = 1.4826 * median(baseV.map((x) => Math.abs(x - vm))) || 1;
  const vz = (x: number) => (x > 0 && isFinite(vm) ? (Math.log(x) - vm) / vmad : 0);
  let touch: { side: "low" | "up"; j: number } | null = null;
  for (let j = n - 1; j >= n - 5; j--) {
    if (l[j] <= B.lo[j]) { touch = { side: "low", j }; break; }
    if (h[j] >= B.up[j]) { touch = { side: "up", j }; break; }
  }
  if (!touch) return null;
  let vRef = 0; for (let q = touch.j; q <= i; q++) vRef = Math.max(vRef, va[q]);
  const volZ = vz(vRef), j = touch.j, low = touch.side === "low";
  const half = (B.up[j] - B.lo[j]) / (2 * S.k);
  const exc = Math.max(0, low ? (B.lo[j] - l[j]) / half : (h[j] - B.up[j]) / half);
  const rev = j <= p && (low ? c[p] > o[p] : c[p] < o[p]) &&
    (low ? c[p] > B.lo[p] && c[i] > B.lo[i] : c[p] < B.up[p] && c[i] < B.up[i]) && volZ >= 1;
  const D = 1 - Math.exp(-2 * exc), V = clamp(volZ / 3, 0, 1), R = clamp(low ? (35 - r) / 20 : (r - 65) / 20, 0, 1);
  const M = isFinite(hl) ? clamp(1 - hl / 40, 0, 1) : 0;
  const score = Math.round(100 * (0.25 * D + 0.25 * V + 0.15 * R + 0.20 * (rev ? 1 : 0) + 0.15 * M));
  return { sym, price: c[i], z: B.z[i], hl, rev, score, side: touch.side, mid: B.mid[i], atr: atr(h, l, c) };
}

// ---------- one bot tick ----------
async function run() {
  const now = Date.now();
  const { data: st, error: e1 } = await db.from("bot_state").select("*").eq("id", 1).single();
  if (e1) throw e1;
  const S = st.settings as Settings;
  const { data: open, error: e2 } = await db.from("positions").select("*");
  if (e2) throw e2;
  const tk = await api("/api/v3/ticker/24hr");
  const list: string[] = tk.filter((x: any) => x.symbol.endsWith("USDT") && !STABLE.has(x.symbol.slice(0, -4)) && +x.quoteVolume > 0 && x.closeTime > now - 864e5)
    .sort((a: any, b: any) => b.quoteVolume - a.quoteVolume).slice(0, S.top).map((x: any) => x.symbol);
  for (const p of open!) if (!list.includes(p.sym)) list.push(p.sym);

  const cache: Record<string, K[]> = {}, rows: NonNullable<ReturnType<typeof analyze>>[] = [];
  const limit = Math.min(1000, S.N + 150);
  await pool(list, 10, async (sym) => {
    try { const Kl = await api(`/api/v3/klines?symbol=${sym}&interval=${S.tf}&limit=${limit}`); cache[sym] = Kl; const r = analyze(sym, Kl, S); if (r) rows.push(r); } catch { /* skip pair */ }
  });

  let balance = st.balance as number;
  const closed: any[] = [], stillOpen: any[] = [];
  for (const p of open!) {
    const Kl = cache[p.sym]; if (!Kl) { stillOpen.push(p); continue; }
    const start = Math.floor(p.time / p.tfms) * p.tfms + p.tfms;
    let exit: number | null = null, reason = "";
    for (const k of Kl) {
      if (k[0] < start) continue;
      const hi = +k[2], lo = +k[3];
      if (p.side === "LONG" ? lo <= p.sl : hi >= p.sl) { exit = p.sl; reason = "стоп"; break; }
      if (p.side === "LONG" ? hi >= p.tp : lo <= p.tp) { exit = p.tp; reason = "тейк"; break; }
    }
    const c = +Kl[Kl.length - 1][4]; p.last = c;
    if (exit == null) {
      if (p.side === "LONG" ? c <= p.sl : c >= p.sl) { exit = c; reason = "стоп"; }
      else if (p.side === "LONG" ? c >= p.tp : c <= p.tp) { exit = c; reason = "тейк"; }
      else if (now - p.time > 48 * p.tfms) { exit = c; reason = "тайм-стоп"; }
    }
    if (exit == null) { stillOpen.push(p); continue; }
    const pnl = (p.side === "LONG" ? exit - p.entry : p.entry - exit) * p.qty - (p.entry + exit) * p.qty * FEE;
    balance += pnl;
    closed.push({ id: p.id, sym: p.sym, side: p.side, entry: p.entry, exit, tp: p.tp, sl: p.sl, qty: p.qty, pnl, time: p.time, tclose: now, note: reason + " · " + p.note });
  }

  const tfms = TFMS[S.tf];
  const { data: recent } = await db.from("trades").select("sym").gt("tclose", now - 4 * tfms);
  const cool = new Set([...(recent ?? []).map((x: any) => x.sym), ...closed.map((x) => x.sym)]);
  const opened: any[] = [];
  const cands = rows.filter((r) => r.rev && r.score >= S.minScore && !stillOpen.some((p) => p.sym === r.sym) && !cool.has(r.sym)).sort((a, b) => b.score - a.score);
  for (const r of cands) {
    if (stillOpen.length + opened.length >= 3) break;
    const side = r.side === "low" ? "LONG" : "SHORT", e = r.price, sg = side === "LONG" ? 1 : -1;
    const tpD = clamp(Math.abs(r.mid - e) / e, 0.01, 0.03), slD = clamp(1.5 * r.atr / e, 0.008, 0.025);
    if (tpD < 0.8 * slD) continue;
    const qty = Math.min(balance * 0.02 / (e * slD), balance / 3 / e);
    if (!(qty > 0)) continue;
    opened.push({ id: now + r.sym, sym: r.sym, side, entry: e, last: e, tp: e * (1 + sg * tpD), sl: e * (1 - sg * slD), qty, time: now, tfms,
      note: `${r.side === "low" ? "отскок от низа" : "откат от верха"} · оценка ${r.score} · z ${r.z.toFixed(1)}σ · T½ ${isFinite(r.hl) ? r.hl.toFixed(0) + " св." : "∞"}` });
  }

  if (closed.length) {
    const { error } = await db.from("trades").insert(closed); if (error) throw error;
    const { error: e3 } = await db.from("positions").delete().in("id", closed.map((x) => x.id)); if (e3) throw e3;
  }
  const upserts = [...stillOpen.map((p) => ({ ...p })), ...opened];
  if (upserts.length) { const { error } = await db.from("positions").upsert(upserts); if (error) throw error; }
  await db.from("bot_state").update({ balance, checked_at: new Date(now).toISOString(), scanned: Object.keys(cache).length, last_error: null }).eq("id", 1);
  return { scanned: Object.keys(cache).length, signals: rows.filter((r) => r.rev).length, opened: opened.length, closed: closed.length, open: upserts.length };
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
