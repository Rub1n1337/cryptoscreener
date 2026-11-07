// Мульти-тест: База + SMC Order Block + SMC Тренд + Liquidity Sweep (ОПТИМИЗИРОВАННЫЙ)
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';

const DAY = 864e5;

function analyzeSMC(K) {
  const n = K.length, obs = [], trends = new Array(n).fill(0);
  let pivotHigh = { price: -Infinity, index: -1 };
  let pivotLow = { price: Infinity, index: -1 };
  let currentTrend = 0;

  for (let i = 20; i < n; i++) {
    const check = i - 10;
    let isHigh = true, isLow = true;
    for (let j = check - 10; j <= i; j++) {
      if (K[j][2] > K[check][2]) isHigh = false; // high
      if (K[j][3] < K[check][3]) isLow = false;  // low
    }
    if (isHigh) pivotHigh = { price: K[check][2], index: check };
    if (isLow) pivotLow = { price: K[check][3], index: check };

    const close = K[i][4];
    
    if (pivotHigh.index !== -1 && pivotLow.index !== -1) {
      if (close > pivotHigh.price && currentTrend !== 1) {
        currentTrend = 1;
        let obIndex = pivotLow.index;
        for (let j = pivotLow.index; j <= i; j++) {
          if (K[j][3] < K[obIndex][3]) obIndex = j;
        }
        obs.push({ top: K[obIndex][2], bottom: K[obIndex][3], side: 'LONG', startIndex: obIndex, endIndex: -1 });
      } else if (close < pivotLow.price && currentTrend !== -1) {
        currentTrend = -1;
        let obIndex = pivotHigh.index;
        for (let j = pivotHigh.index; j <= i; j++) {
          if (K[j][2] > K[obIndex][2]) obIndex = j;
        }
        obs.push({ top: K[obIndex][2], bottom: K[obIndex][3], side: 'SHORT', startIndex: obIndex, endIndex: -1 });
      }
    }
    
    trends[i] = currentTrend;
    
    for (const ob of obs) {
      if (ob.endIndex === -1) {
        if (ob.side === 'LONG' && K[i][4] < ob.bottom) ob.endIndex = i;
        if (ob.side === 'SHORT' && K[i][4] > ob.top) ob.endIndex = i;
      }
    }
  }
  return { obs, trends };
}

// ОПТИМИЗАЦИЯ: передаем готовый ATR (atrVal), а не режем массив свечей заново
function simulateTrade(K, i, side, atrVal, fee, slip) {
  const entry = K[i][4];
  const slD = Math.max(atrVal * 1.5 / entry, 0.008);
  const sl = side === 'LONG' ? entry * (1 - slD) : entry * (1 + slD);
  const tp = side === 'LONG' ? entry + (entry - sl) * 2 : entry - (sl - entry) * 2;

  let exit = null, reason = '';
  for (let j = i + 1; j < Math.min(K.length, i + 48); j++) {
    if (side === 'LONG') {
      if (K[j][3] <= sl) { exit = sl * (1 - slip); reason = 'stop'; break; }
      if (K[j][2] >= tp) { exit = tp; reason = 'take'; break; }
    } else {
      if (K[j][2] >= sl) { exit = sl * (1 + slip); reason = 'stop'; break; }
      if (K[j][3] <= tp) { exit = tp; reason = 'take'; break; }
    }
  }
  if (!exit) { exit = K[Math.min(K.length - 1, i + 48)][4]; reason = 'time'; }

  const sg = side === 'LONG' ? 1 : -1;
  const gross = sg * (exit - entry);
  const cost = (entry + exit) * fee;
  const r = (gross - cost) / Math.abs(entry - sl);
  return r;
}

export async function start(opt = {}) {
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const years = yearsBack(), pl = await pools(years);
  const results = { base: [], ob: [], trend: [], sweep: [] };

  const set = { method: 'log', N: 210, k: 3.5, tf: '1h', minScore: 60 };

  for (const [yi, [y0, y1]] of years.entries()) {
    const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`;
    S.phase = label; S.total = pl[yi].length; S.done = 0;
    
    await pool(pl[yi], opt.par ?? 6, async (sym) => {
      try {
        const K = await klines(sym, '1h', y0 - 30 * DAY, y1);
        if (K.length < 300) return;
        
        const Q = M.prepare(K, set); // Здесь уже посчитан массив ATR (Q.A)
        const { obs, trends } = analyzeSMC(K);

        for (let i = 210; i < K.length - 48; i++) {
          const r = M.signalAt(Q, i, sym, K[i][0] + 36e5, true);
          if (!r || !r.rev || r.score < 60) continue;

          const side = r.side === 'low' ? 'LONG' : 'SHORT';
          // Берем готовый ATR для этой свечи
          const baseR = simulateTrade(K, i, side, Q.A[i], M.FEE, M.SLIP);
          
          results.base.push({ r: baseR, year: label });

          const inZone = r.side === 'low' ? r.lo : r.up;
          
          const hasOB = obs.some(ob => ob.startIndex <= i && (ob.endIndex === -1 || ob.endIndex > i) &&
            (ob.side === 'LONG' ? (ob.top >= inZone * 0.99 && ob.bottom <= inZone * 1.01) : (ob.bottom <= inZone * 1.01 && ob.top >= inZone * 0.99))
          );
          if (hasOB) results.ob.push({ r: baseR, year: label });

          const trendOk = (side === 'LONG' && trends[i] === 1) || (side === 'SHORT' && trends[i] === -1);
          if (trendOk) results.trend.push({ r: baseR, year: label });

          const candleRange = K[i][2] - K[i][3];
          const bodyLow = Math.min(K[i][1], K[i][4]);
          const bodyHigh = Math.max(K[i][1], K[i][4]);
          
          const isSweep = side === 'LONG' 
            ? (bodyLow - K[i][3]) > candleRange * 0.5 && candleRange > 0
            : (K[i][2] - bodyHigh) > candleRange * 0.5 && candleRange > 0;
            
          if (isSweep) results.sweep.push({ r: baseR, year: label });
        }
      } catch (e) { console.error(sym, e); }
      S.done++;
    });
  }

  S.phase = 'done';
  const report = {};
  const yLabels = [...new Set(results.base.map(r => r.year))];
  
  for (const y of yLabels) {
    const calc = (arr) => {
      if (!arr.length) return { n: 0, win: '0%', avgR: '0.000' };
      const n = arr.length, w = arr.filter(t => t.r > 0).length;
      const sumR = arr.reduce((s, t) => s + t.r, 0);
      return { n, win: (w/n*100).toFixed(0)+'%', avgR: (sumR / n).toFixed(3) };
    };
    report[y] = {
      '1. База (как сейчас)': calc(results.base.filter(x => x.year === y)),
      '2. С Order Block': calc(results.ob.filter(x => x.year === y)),
      '3. По тренду SMC': calc(results.trend.filter(x => x.year === y)),
      '4. Liquidity Sweep': calc(results.sweep.filter(x => x.year === y))
    };
  }
  
  return { report };
}