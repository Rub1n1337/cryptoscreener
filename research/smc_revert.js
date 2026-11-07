// Гипотеза 1: Фильтр SMC Order Block для отскока от полос Боллинджера
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';

const DAY = 864e5;

// Ищем Order Blocks
function findOBs(K, swingSize = 10) {
  const n = K.length, obs = [];
  let pivotHigh = { price: -Infinity, index: -1 };
  let pivotLow = { price: Infinity, index: -1 };
  let trend = 0;

  for (let i = swingSize * 2; i < n; i++) {
    const check = i - swingSize;
    let isHigh = true, isLow = true;
    for (let j = check - swingSize; j <= i; j++) {
      if (K[j][2] > K[check][2]) isHigh = false; 
      if (K[j][3] < K[check][3]) isLow = false;  
    }
    if (isHigh) pivotHigh = { price: K[check][2], index: check };
    if (isLow) pivotLow = { price: K[check][3], index: check };

    const close = K[i][4];
    // CHoCH вверх (ищем бычий OB)
    if (pivotHigh.index !== -1 && close > pivotHigh.price && trend !== 1) {
      trend = 1;
      let obIndex = pivotLow.index;
      for (let j = pivotLow.index; j <= i; j++) {
        if (K[j][3] < K[obIndex][3]) obIndex = j;
      }
      obs.push({ top: K[obIndex][2], bottom: K[obIndex][3], side: 'LONG', startIndex: obIndex });
    } 
    // CHoCH вниз (ищем медвежий OB)
    else if (pivotLow.index !== -1 && close < pivotLow.price && trend !== -1) {
      trend = -1;
      let obIndex = pivotHigh.index;
      for (let j = pivotHigh.index; j <= i; j++) {
        if (K[j][2] > K[obIndex][2]) obIndex = j;
      }
      obs.push({ top: K[obIndex][2], bottom: K[obIndex][3], side: 'SHORT', startIndex: obIndex });
    }
  }
  return obs;
}

// Симуляция сделки
function simulateTrade(K, i, side, S, ob, fee, slip) {
  const entry = K[i][4];
  const atr = M.atr(K.slice(0, i+1).map(k => k[2]), K.slice(0, i+1).map(k => k[3]), K.slice(0, i+1).map(k => k[4]), 14);
  const slD = Math.max(atr * 1.5 / entry, 0.008); // стоп 1.5 ATR, минимум 0.8%
  const sl = side === 'LONG' ? entry * (1 - slD) : entry * (1 + slD);
  const tp = side === 'LONG' ? entry + (entry - sl) * 2 : entry - (sl - entry) * 2; // RR 1:2

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
  return { r, reason };
}

export async function start(opt = {}) {
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const years = yearsBack(), pl = await pools(years);
  const results = [];

  const set = { method: 'log', N: 210, k: 3.5, tf: '1h', minScore: 0 }; // правила как у общего бота

  for (const [yi, [y0, y1]] of years.entries()) {
    const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`;
    S.phase = label; S.total = pl[yi].length; S.done = 0;
    
    await pool(pl[yi], opt.par ?? 6, async (sym) => {
      try {
        const K = await klines(sym, '1h', y0 - 30 * DAY, y1);
        if (K.length < 200) return;
        
        const Q = M.prepare(K, set); // считаем канал
        const obs = findOBs(K, 10);

        for (let i = 210; i < K.length; i++) {
          const r = M.signalAt(Q, i, sym, K[i][0] + 36e5, true);
          if (!r || !r.rev) continue; // берем только подтвержденные развороты

          // Проверяем, есть ли OB в зоне касания (у нижней или верхней границы)
          const inZone = r.side === 'low' ? r.lo : r.up;
          const hasOB = obs.some(ob => {
            // OB должен быть создан не позже текущей свечи и не старше 100 свечей
            if (ob.startIndex > i || i - ob.startIndex > 100) return false;
            // Если это LONG, ищем Bullish OB, который пересекается с нижней границей
            if (r.side === 'low' && ob.side === 'LONG') {
              return ob.top >= inZone * 0.99 && ob.bottom <= inZone * 1.01;
            }
            // Если SHORT, ищем Bearish OB у верхней границы
            if (r.side === 'up' && ob.side === 'SHORT') {
              return ob.bottom <= inZone * 1.01 && ob.top >= inZone * 0.99;
            }
            return false;
          });

          const trade = simulateTrade(K, i, r.side === 'low' ? 'LONG' : 'SHORT', set, hasOB, M.FEE, M.SLIP);
          results.push({ ...trade, year: label, hasOB });
        }
      } catch (e) { console.error(sym, e); }
      S.done++;
    });
  }

  S.phase = 'done';
  
  // Сборка отчета: отдельно "с OB" и "без OB"
  const report = {};
  const yLabels = [...new Set(results.map(r => r.year))];
  
  for (const y of yLabels) {
    const all = results.filter(r => r.year === y);
    const withOB = all.filter(r => r.hasOB);
    const noOB = all.filter(r => !r.hasOB);
    
    const calc = (arr) => {
      if (!arr.length) return { n: 0, win: '0%', avgR: '0.00' };
      const n = arr.length, w = arr.filter(t => t.r > 0).length;
      const sumR = arr.reduce((s, t) => s + t.r, 0);
      return { n, win: (w/n*100).toFixed(0)+'%', avgR: (sumR / n).toFixed(2) };
    };

    report[y] = {
      'Всего (без фильтра)': calc(all),
      'С Order Block': calc(withOB),
      'Без Order Block': calc(noOB)
    };
  }
  
  return { report };
}