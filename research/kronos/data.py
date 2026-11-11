# Step 1 of the Kronos stand (docs/RESEARCH-KRONOS.md): the pool and its 1h candles from the stored history in R2.
#   research/kronos/.ext/venv/Scripts/python.exe -I research/kronos/data.py
# Pool: every USDT pair (no stablecoins / gold / wrapped: math.js STABLE) ever in the daily top-50 by quote turnover between
# 2024-06-10 and the end of the test, delisted ones included, plus math.js MAJORS — as stage05.pools(), with top-50.
# Candles: 1h from 2024-06 (context before the first forecast) to the last stored month; a pair R2 doesn't hold comes from
# Binance's public API (data-api.binance.vision) whole. Writes research/data/kronos/1h/<SYM>.npz and pool.json; files there
# are kept (rerun = resume). R2 serves CORS only to localhost:8765, which doesn't matter outside a browser.
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import *

def unpack(o, tf_ms, m):
    t0 = month_start(m); t = np.asarray(o['t'], dtype=np.int64) * tf_ms + t0
    return t, [np.asarray(o[c], dtype=np.float64) for c in ('o', 'h', 'l', 'c', 'vo', 'q')]

def binance(sym, a, b):
    rows = []
    while a < b:
        K = json.loads(get(f'{API}/klines?symbol={urllib.parse.quote(sym)}&interval=1h&startTime={a}&endTime={b - 1}&limit=1000') or b'[]')
        if not K: break
        rows += [[k[0], +float(k[1]), +float(k[2]), +float(k[3]), +float(k[4]), +float(k[5]), +float(k[7])] for k in K]
        a = K[-1][0] + HOUR
    return rows

def main():
    os.makedirs(os.path.join(DATA, '1h'), exist_ok=True)
    I = json.loads(get(BASE + '/index.json'))
    d = I['d']; m_last = d['m1']
    # daily quote turnover of every stored pair
    qv = {}
    def day_file(m):
        o = jgz(f'{BASE}/v1/1d/{m}.json.gz')
        return m, o
    with ThreadPoolExecutor(8) as ex:
        for m, o in ex.map(day_file, months('2024-06', month_of(TEST1 + DAY))):
            if not o: print('no daily file', m); continue
            for s, col in o['s'].items():
                t, (op, h, l, c, v, q) = unpack(col, DAY, m)
                qv.setdefault(s, {}).update(zip(t.tolist(), q.tolist()))
    syms = [s for s in qv if s.endswith('USDT') and s[:-4] not in STABLE]
    pool = set(MAJORS)
    for day in range(utc('2024-06-10'), TEST1 + DAY, DAY):
        top = sorted(((qv[s].get(day, 0), s) for s in syms), reverse=True)[:POOL_TOP]
        pool.update(s for v, s in top if v > 0)
    pool = sorted(pool)
    print('pool', len(pool), 'pairs')
    stored = I['s']
    a0 = utc('2024-06-01')

    def one(s):
        f = candles_path(s)
        if os.path.exists(f): return s, 'kept'
        ser = stored.get(s, {}).get('1h')
        T, cols = [], [[] for _ in range(6)]
        src = 'r2'
        if ser:
            for m in months(max('2024-06', ser[0]), ser[1]):
                o = jgz(f'{BASE}/v1/1h/{urllib.parse.quote(s)}/{m}.json.gz')
                if not o: continue
                if o.get('v') != 1 or o.get('s') != s or o.get('tf') != '1h' or o.get('m') != m: raise RuntimeError('header ' + s + m)
                t, cs = unpack(o, HOUR, m)
                T.append(t); [cols[j].append(cs[j]) for j in range(6)]
        if not T:
            src = 'binance'
            rows = binance(s, a0, TEST1 + 2 * DAY)
            if not rows: return s, 'none'
            R = np.array(rows); T = [R[:, 0].astype(np.int64)]; cols = [[R[:, j + 1]] for j in range(6)]
        t = np.concatenate(T)
        keep = t >= a0
        out = dict(t=t[keep], **{k: np.concatenate(cols[j])[keep] for j, k in enumerate(('o', 'h', 'l', 'c', 'v', 'q'))})
        if len(out['t']) and not np.all(np.diff(out['t']) > 0): raise RuntimeError('order ' + s)
        np.savez(f, **out)
        return s, src

    res = {}
    with ThreadPoolExecutor(8) as ex:
        for s, how in ex.map(one, pool):
            res[s] = how
    print({k: sum(1 for v in res.values() if v == k) for k in set(res.values())})
    json.dump({'pool': pool, 'src': res, 'index_created': I.get('created'), 'daily_last': d['last']}, open(os.path.join(DATA, 'pool.json'), 'w'))

if __name__ == '__main__':
    main()
