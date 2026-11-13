// «No more than 2 losing trades a day and 6 a week» for the bot (docs/RESEARCH-LOSS-LIMIT.md; rules written before the run).
// Works on the trades of research/funding-filter.js (same profiles, years and honest top-50). In the preview (localhost:8765):
//   const F = await import('/research/funding-filter.js'); await F.start('sw4h'); await F.start('rev1h');   (or reuse a run)
//   const L = await import('/research/loss-limit.js?' + Date.now()); L.report(F.out, 'sw4h'); L.streaks(F.out)
// Nothing is written anywhere.
const DAY = 864e5, RUNS = 300;
export const VARIANTS = [{ id: '2/день + 6/нед', d: 2, w: 6 }, { id: '2/день', d: 2, w: Infinity }, { id: '6/нед', d: Infinity, w: 6 }];
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const dayOf = t => Math.floor(t / DAY), weekOf = t => Math.floor((t / DAY + 3) / 7);   // 1970-01-01 was a Thursday: +3 puts weeks on Mondays

// the trades the limit lets through: in entry order, a trade is skipped when the kept trades that closed at a loss before its entry
// number ≥ d that UTC day or ≥ w that week
export function limit(tr, d, w) {
  const byEntry = [...tr].sort((a, b) => a.time - b.time), kept = [];
  for (const x of byEntry) {
    let nd = 0, nw = 0;
    for (const k of kept) if (k.r < 0 && k.tclose < x.time) { if (dayOf(k.tclose) === dayOf(x.time)) nd++; if (weekOf(k.tclose) === weekOf(x.time)) nw++; }
    if (nd < d && nw < w) kept.push(x);
  }
  return new Set(kept);
}
const sumR = tr => tr.reduce((a, x) => a + x.r, 0);
function ddR(tr) { let c = 0, pk = 0, dd = 0; for (const x of tr) { c += x.r; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); } return dd; }
const f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1), f2 = x => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2), pc = x => x == null ? '—' : Math.round(x * 100) + '%';

export function rows(out, prof) {
  const R = [];
  for (const y of out[prof].years) {
    const tr = y.trades.filter(x => x.r != null && isFinite(x.r)).sort((a, b) => a.tclose - b.tclose);
    for (const v of VARIANTS) {
      const keep = limit(tr, v.d, v.w), kept = tr.filter(x => keep.has(x)), sk = tr.filter(x => !keep.has(x)), k = sk.length;
      const g = rng(1), rD = [], rR = [];
      for (let n = 0; n < RUNS; n++) {
        const pick = new Set(); while (pick.size < k) pick.add(tr[Math.floor(g() * tr.length)]);
        const kk = tr.filter(x => !pick.has(x)); rD.push(ddR(kk)); rR.push(sumR(kk));
      }
      const dF = ddR(kept), sF = sumR(kept);
      R.push({ prof, year: y.label.slice(0, 4) + '–' + y.label.slice(13, 15), v: v.id, n: tr.length, skipped: k, baseR: sumR(tr), baseDD: ddR(tr), R: sF, DD: dF,
        rankDD: rD.filter(d => d >= dF).length / RUNS, rankR: rR.filter(s => s <= sF).length / RUNS, skippedMean: k ? sumR(sk) / k : null, keptMean: kept.length ? sF / kept.length : null });
    }
  }
  return R;
}
export function report(out, prof) {
  const L = ['| Год | Вариант | Сделок | Пропущено | Итог R: база → лимит | Просадка R: база → лимит | Ранг просадки | Ранг итога | R пропущенных / оставшихся |', '|---|---|---|---|---|---|---|---|---|'];
  for (const x of rows(out, prof)) L.push(`| ${x.year} | ${x.v} | ${x.n} | ${x.skipped} | ${f1(x.baseR)} → ${f1(x.R)} | ${x.baseDD.toFixed(1)} → ${x.DD.toFixed(1)} | ${pc(x.rankDD)} | ${pc(x.rankR)} | ${f2(x.skippedMean)} / ${f2(x.keptMean)} |`);
  return L.join('\n');
}
export function verdict(out) {
  const ok = x => x.DD < x.baseDD && x.R >= x.baseR && x.rankDD >= 0.9 && x.rankR >= 0.9;
  return Object.fromEntries(VARIANTS.map(v => [v.id, Object.keys(out).flatMap(p => rows(out, p).filter(x => x.v === v.id)).map(x => `${x.prof} ${x.year}: ${ok(x) ? 'да' : 'нет'}`)]));
}
// serial dependence of outcomes (Kaminski & Lo): share of losers after a loser and after a winner, in order of closing
export function streaks(out) {
  const L = ['| Профиль | Год | Убыточных всего | После убыточной | После прибыльной |', '|---|---|---|---|---|'];
  for (const [p, run] of Object.entries(out)) for (const y of run.years) {
    const tr = y.trades.filter(x => x.r != null && isFinite(x.r)).sort((a, b) => a.tclose - b.tclose);
    let ll = 0, l = 0, wl = 0, w = 0;
    for (let i = 1; i < tr.length; i++) { if (tr[i - 1].r < 0) { l++; if (tr[i].r < 0) ll++; } else { w++; if (tr[i].r < 0) wl++; } }
    L.push(`| ${p} | ${y.label.slice(0, 4)}–${y.label.slice(13, 15)} | ${pc(tr.filter(x => x.r < 0).length / tr.length)} | ${pc(ll / l)} (${l}) | ${pc(wl / w)} (${w}) |`);
  }
  return L.join('\n');
}
