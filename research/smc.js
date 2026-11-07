// SMC (Smart Money Concepts) — финальный честный тест (без микро-стопов)
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';

const DAY = 864e5;

function testSMC(K, tf, swingSize, rr, fee, slip) {
  const n = K.length, out = [];
  let pivotHigh = { price: -Infinity, index: -1 };
  let pivotLow = { price: Infinity, index: -1 };
  let trend = 0; 
  let ob = null; 

  for (let i = swingSize * 2; i < n; i++) {
    // 1. Локальные экстремумы (без фильтра волатильности, он тут не нужен)
    const check = i - swingSize;
    let isHigh = true, isLow = true;
    for (let j = check - swingSize; j <= i; j++) {
      if (K[j][2] > K[check][2]) isHigh = false; 
      if (K[j][3] < K[check][3]) isLow = false;  
    }
    if (isHigh) pivotHigh = { price: K[check][2], index: check };
    if (isLow) pivotLow = { price: K[check][3], index: check };

    // 2. Слом структуры (CHoCH)
    const close = K[i][4];
    if (pivotHigh.index !== -1 && close > pivotHigh.price && trend !== 1) {
      trend = 1;
      // Ищем Order Block (последняя медвежья свеча перед импульсом)
      let obIndex = i - 1;
      while (obIndex > pivotLow.index && K[obIndex][4] >= K[obIndex][1]) obIndex--;
      
      if (obIndex > pivotLow.index) {
        ob = { top: K[obIndex][2], bottom: K[obIndex][3], side: 'LONG', status: 'waiting' };
      }
    } else if (pivotLow.index !== -1 && close < pivotLow.price && trend !== -1) {
      trend = -1;
      // Ищем Bearish Order Block (последняя бычья свеча)
      let obIndex = i - 1;
      while (obIndex > pivotHigh.index && K[obIndex][4] <= K[obIndex][1]) obIndex--;

      if (obIndex > pivotHigh.index) {
        ob = { top: K[obIndex][2], bottom: K[obIndex][3], side: 'SHORT', status: 'waiting' };
      }
    }

    // 3. Управление ордером
    if (ob) {
      if (ob.status === 'waiting') {
        // Отмена, если цена пробила OB до входа
        if (ob.side === 'LONG' && K[i][4] < ob.bottom) ob = null;
        else if (ob.side === 'SHORT' && K[i][4] > ob.top) ob = null;
        
        // Вход LONG: цена коснулась OB и закрылась выше его верха (подтверждение)
        else if (ob.side === 'LONG' && K[i][3] <= ob.top && K[i][4] > ob.bottom) {
          const entry = K[i][4]; 
          // ЖЕСТКИЙ ФИЛЬТР: стоп не может быть меньше 0.5% от цены
          const minStop = entry * 0.005;
          const obRisk = entry - ob.bottom;
          const risk = Math.max(minStop, obRisk);
          const sl = entry - risk;
          const tp = entry + risk * rr;
          
          // Фильтр: если тейк меньше 3 комиссий, пропускаем (мусорная сделка)
          if ((tp - entry) > (entry * fee * 3)) {
            ob.status = 'active'; ob.entry = entry; ob.sl = sl; ob.tp = tp; ob.fill = i;
          } else ob = null;
        }
        // Вход SHORT: цена коснулась OB и закрылась ниже
        else if (ob.side === 'SHORT' && K[i][2] >= ob.bottom && K[i][4] < ob.top) {
          const entry = K[i][4];
          const minStop = entry * 0.005;
          const obRisk = ob.top - entry;
          const risk = Math.max(minStop, obRisk);
          const sl = entry + risk;
          const tp = entry - risk * rr;

          if ((entry - tp) > (entry * fee * 3)) {
            ob.status = 'active'; ob.entry = entry; ob.sl = sl; ob.tp = tp; ob.fill = i;
          } else ob = null;
        }
      } else if (ob.status === 'active' && i > ob.fill) {
        // Выход (на следующих свечах, без заглядывания в будущее)
        let exit = null, reason = '';
        if (ob.side === 'LONG') {
          if (K[i][3] <= ob.sl) { exit = ob.sl * (1 - slip); reason = 'stop'; }
          else if (K[i][2] >= ob.tp) { exit = ob.tp; reason = 'take'; }
        } else {
          if (K[i][2] >= ob.sl) { exit = ob.sl * (1 + slip); reason = 'stop'; }
          else if (K[i][3] <= ob.tp) { exit = ob.tp; reason = 'take'; }
        }
        // Тайм-стоп 48 свечей
        if (!exit && i - ob.fill > 48) { exit = K[i][4] * (1 - (ob.side === 'LONG' ? 1 : -1) * slip); reason = 'time'; }
        
        if (exit) {
          const sg = ob.side === 'LONG' ? 1 : -1;
          const gross = sg * (exit - ob.entry);
          const cost = (ob.entry + exit) * fee + (ob.entry * slip * 2); // Плюс проскальзывание на вход
          const risk = Math.abs(ob.entry - ob.sl);
          const r = (gross - cost) / risk;
          if (isFinite(r)) out.push({ r, reason, time: K[i][0] });
          ob = null;
        }
      }
    }
  }
  return out;
}

export async function start(opt = {}) {
  const swingSize = opt.swingSize ?? 20, rr = opt.rr ?? 2, fee = M.FEE, slip = M.SLIP;
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const years = yearsBack(), pl = await pools(years);
  const results = [];

  for (const [yi, [y0, y1]] of years.entries()) {
    const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`;
    S.phase = label; S.total = pl[yi].length; S.done = 0;
    await pool(pl[yi], opt.par ?? 6, async (sym) => {
      try {
        const K = await klines(sym, '1h', y0 - 30 * DAY, y1);
        if (K.length > 100) {
          const t1 = testSMC(K, '1h', swingSize, rr, fee, slip);
          results.push(...t1.map(t => ({ ...t, year: label, tf: '1h' })));
          const K4 = [];
          for (let i = 0; i < K.length; i += 4) {
            if (i + 3 < K.length) K4.push([K[i][0], K[i][1], Math.max(...K.slice(i, i+4).map(k => k[2])), Math.min(...K.slice(i, i+4).map(k => k[3])), K[i+3][4], K.slice(i, i+4).reduce((s, k) => s + k[5], 0)]);
          }
          const t4 = testSMC(K4, '4h', swingSize, rr, fee, slip);
          results.push(...t4.map(t => ({ ...t, year: label, tf: '4h' })));
        }
      } catch {}
      S.done++;
    });
  }

  S.phase = 'done';
  const report = { '1h': {}, '4h': {} };
  const yLabels = [...new Set(results.map(r => r.year))];
  for (const tf of ['1h', '4h']) {
    for (const y of yLabels) {
      const trs = results.filter(r => r.tf === tf && r.year === y);
      if (trs.length) {
        const n = trs.length, w = trs.filter(t => t.r > 0).length, sumR = trs.reduce((s, t) => s + t.r, 0);
        report[tf][y] = { n, win: (w/n*100).toFixed(0)+'%', avgR: (sumR / n).toFixed(2) };
      } else report[tf][y] = { n: 0 };
    }
  }
  return { report };
}