// Notification settings of a server bot's Telegram chat (user_bots.alerts): how they are read, in one copy for the site
// («Мой бот» → Telegram, index.html), the Telegram menu (_shared/tg.ts) and the bot that sends the messages (bot/index.ts).
// Saved in parts — only what changed — and merged by the database (supabase/2026-11-alerts-parts.sql). The value comes from a
// browser or a chat: anything unexpected reads as the default, the same for all three, so what the site and the menu show is
// what the bot does. Plain JS (no types), so the site can import it as it imports math.js.
//   sig:   the bot's own signals — on; top: 0 (the bot's coins) | 50…250 (wider, for trading by hand);
//          when: 'confirmed' (as the bot enters) | 'touch' (at once, then updated); sides: 'both' | 'long' (read as long)
//   quiet: quiet hours, messages come without a sound — on; from, to (hours 0–23); zone (an IANA name, set by the site, follows
//          summer time) or the older tz (minutes east of UTC at the moment of saving; Moscow when unknown)
//   mkt:   «Рынок», a separate filter with its own channel settings, saved on the site — on, tf, top, minScore, method, N, k; null until then
export const TOPS = [0, 50, 100, 150, 250];
const obj = (x) => x && typeof x === "object" ? x : {};
const num = (v, a, b, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
const oneOf = (v, ok, d) => ok.includes(v) ? v : d;

// everything, with the defaults filled in — for showing; the market filter stays when switched off, so its row shows unchecked
export function alertsView(raw) {
  const a = obj(raw), s = obj(a.sig), q = obj(a.quiet), m = a.mkt;
  return {
    sig: { on: s.on !== false, top: oneOf(Math.round(Number(s.top) || 0), TOPS, 0), when: oneOf(s.when, ["confirmed", "touch"], "confirmed"), long: s.sides === "long" },
    quiet: { on: !!q.on, from: Math.round(num(q.from, 0, 23, 23)), to: Math.round(num(q.to, 0, 23, 8)), tz: Math.round(num(q.tz, -720, 840, 180)),
      zone: typeof q.zone === "string" && /^[A-Za-z]+(\/[A-Za-z0-9_+\-]+){0,2}$/.test(q.zone) ? q.zone : null },
    mkt: m && typeof m === "object" ? { on: m.on !== false,
      method: oneOf(m.method, ["log", "classic", "robust", "ewma"], "log"), N: Math.round(num(m.N, 20, 300, 210)), k: num(m.k, 1, 5, 3),
      tf: oneOf(m.tf, ["5m", "15m", "1h", "4h", "1d"], "4h"), minScore: num(m.minScore, 40, 100, 60), top: Math.round(num(m.top, 10, 400, 150)) } : null,
  };
}

// what the bot acts on: quiet hours and the market filter only while they are on (null otherwise)
export function alertsOf(raw) {
  const { sig, quiet: { on: quietOn, ...quiet }, mkt } = alertsView(raw);
  const { on: mktOn, ...market } = mkt || {};
  return { quiet: quietOn ? quiet : null, sig, mkt: mkt && mktOn ? market : null };
}
