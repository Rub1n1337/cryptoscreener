# Step 3 of the Kronos stand (docs/RESEARCH-KRONOS.md): trades from the forecasts, random entries, naive forecasts, signs.
#   research/kronos/.ext/venv/Scripts/python.exe -I -u research/kronos/evaluate.py          (after predict.py)
# Prints markdown tables, writes research/data/kronos/results.json. No GPU, a minute or two.
# Universe: every (point, pair) that has a forecast — the honest top-20 at T minus pairs listed < 21 days ago. The naive
# forecasts and the random entries use the same universe, so all of them see the same coins at the same moments.
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import *

def main():
    sys.stdout.reconfigure(encoding="utf-8")
    P = json.load(open(os.path.join(DATA, 'pool.json')))['pool']
    C = {s: load(s) for s in P}
    pd_ = os.path.join(DATA, 'pred')
    T_, S_, C0, PR = [], [], [], []
    drops = 0; slots = 0
    for f in sorted(os.listdir(pd_)):
        if not (f.endswith('.npz') and len(f) == 11): continue
        z = np.load(os.path.join(pd_, f))
        T_ += z['T'].tolist(); S_ += [str(x) for x in z['s']]; C0 += z['c0'].tolist(); PR.append(z['p'])
        drops += int(z['drop'].sum()); slots += len(z['drop_T'])
    PR = np.concatenate(PR); T_ = np.array(T_, np.int64); N = len(T_)
    I = np.array([int(np.searchsorted(C[s]['t'], T - HOUR)) for T, s in zip(T_, S_)])
    assert all(C[s]['t'][i] == T - HOUR and C[s]['c'][i] == c0 for s, i, T, c0 in zip(S_, I, T_, C0)), 'forecast / candle mismatch'
    print(f'{N} forecasts at {slots} points; {drops} top places without 21 days of history', flush=True)
    mon = np.array([month_of(int(T)) for T in T_]); half = (T_ >= HALF).astype(int)

    # ATR(14) at the decision bar: mean true range of the last 14 bars
    def atr(K, i):
        a = max(1, i - 13); h, l, pc = K['h'][a:i + 1], K['l'][a:i + 1], K['c'][a - 1:i]
        return float(np.mean(np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))))
    ATR = np.array([atr(C[s], i) for s, i in zip(S_, I)])

    def trade(k, sg, H, stop):
        """net return of a trade from the close of bar I[k], side sg, H bars; stop: 2 × ATR(14) from the entry close."""
        K = C[S_[k]]; i = int(I[k]); c0 = K['c'][i]; n = len(K['t'])
        T_exit = K['t'][i] + H * HOUR
        j = min(int(np.searchsorted(K['t'], T_exit, 'right')) - 1, n - 1)   # exit bar (a gap or a delisting: the last bar not later)
        px = K['c'][j]; hrs = (K['t'][j] - K['t'][i]) / HOUR
        if stop:
            st = c0 - sg * STOP_ATR * ATR[k]
            for b in range(i + 1, j + 1):
                o, lo, hi = K['o'][b], K['l'][b], K['h'][b]
                if sg > 0 and o <= st or sg < 0 and o >= st: px = o; hrs = (K['t'][b] - K['t'][i]) / HOUR - 1; break
                if sg > 0 and lo <= st or sg < 0 and hi >= st: px = st; hrs = (K['t'][b] - K['t'][i]) / HOUR; break
        e = c0 * (1 + sg * SLIP); ex = px * (1 - sg * SLIP)
        fin = e * BORROW_DAY * hrs / 24 if sg < 0 else 0
        return (sg * (ex - e) - (e + ex) * FEE - fin) / e

    def actual(H):
        out = np.empty(N)
        for k in range(N):
            K = C[S_[k]]; i = int(I[k]); j = min(int(np.searchsorted(K['t'], K['t'][i] + H * HOUR, 'right')) - 1, len(K['t']) - 1)
            out[k] = K['c'][j] / K['c'][i] - 1
        return out

    res = {'N': N, 'points': slots, 'dropped': drops, 'combos': {}, 'diag': {}}
    rng = np.random.default_rng(1)
    months_ = sorted(set(mon)); idx_m = {m: np.where(mon == m)[0] for m in months_}
    for H in HS:
        A = actual(H)
        med = np.median(PR[:, :, H - 1], 1) / np.array(C0) - 1
        n1 = np.array([C[s]['c'][i] / C[s]['o'][i] - 1 for s, i in zip(S_, I)])
        n2 = np.array([C[s]['c'][i] / C[s]['c'][max(0, i - H)] - 1 for s, i in zip(S_, I)])
        sig = {'kronos': med, 'naive_last_1h': n1, 'naive_last_H': n2}
        # sign hit rate, rank correlation, quintiles of |m|
        rank = lambda x: np.argsort(np.argsort(x)).astype(float)
        D = {}
        for name, m in sig.items():
            nz = (m != 0) & (A != 0)
            hit = float(np.mean(np.sign(m[nz]) == np.sign(A[nz])))
            rho = float(np.corrcoef(rank(m), rank(A))[0, 1])
            q = np.quantile(np.abs(m), [0.2, 0.4, 0.6, 0.8]); b = np.searchsorted(q, np.abs(m))
            quint = [float(np.mean(np.sign(m[b == x]) * A[b == x]) * 100) for x in range(5)]
            D[name] = {'hit': hit, 'rho': rho, 'quint_gross_pct': quint, 'quint_edges_pct': (q * 100).tolist()}
        D['up_share'] = float(np.mean(A > 0))
        res['diag'][H] = D
        # every universe item's net return as a long and as a short, both stop settings (for the random entries)
        RL = {st: np.array([trade(k, 1, H, st) for k in range(N)]) for st in (False, True)}
        RS = {st: np.array([trade(k, -1, H, st) for k in range(N)]) for st in (False, True)}
        for kk in KS:
            th = kk * COST
            for name, m in sig.items():
                sg = np.where(m > th, 1, np.where(m < -th, -1, 0)); sel = np.where(sg != 0)[0]
                for st in (False, True):
                    R = np.where(sg[sel] > 0, RL[st][sel], RS[st][sel])
                    G = sg[sel] * A[sel]
                    row = {'n': int(len(sel)), 'mean': float(R.mean() * 100) if len(sel) else None,
                           'gross': float(G.mean() * 100) if len(sel) else None,
                           'win': float(np.mean(R > 0)) if len(sel) else None,
                           't': float(R.mean() / R.std(ddof=1) * np.sqrt(len(R))) if len(sel) > 2 else None,
                           'halves': [float(R[half[sel] == h].mean() * 100) if np.any(half[sel] == h) else None for h in (0, 1)],
                           'n_halves': [int(np.sum(half[sel] == h)) for h in (0, 1)],
                           'long': [int(np.sum(sg[sel] > 0)), float(R[sg[sel] > 0].mean() * 100) if np.any(sg[sel] > 0) else None],
                           'short': [int(np.sum(sg[sel] < 0)), float(R[sg[sel] < 0].mean() * 100) if np.any(sg[sel] < 0) else None]}
                    if name == 'kronos' and len(sel):
                        # random entries: same month, same side, same horizon and stop; 300 runs
                        means = np.empty(RUNS)
                        groups = {}
                        for k, s_ in zip(sel, sg[sel]): groups.setdefault((mon[k], s_), []).append(k)
                        for r in range(RUNS):
                            tot = 0.0
                            for (m_, s_), ks in groups.items():
                                pick = rng.choice(idx_m[m_], len(ks))
                                tot += (RL[st][pick] if s_ > 0 else RS[st][pick]).sum()
                            means[r] = tot / len(sel) * 100
                        row['rand_mean'] = float(means.mean()); row['rand_p95'] = float(np.quantile(means, 0.95))
                        row['rand_rank'] = float(np.mean(means < row['mean']))
                    res['combos'][f'{name}|{H}|{kk}|{"stop" if st else "time"}'] = row
        print('H', H, 'done', flush=True)

    # deliberate look-ahead (predict.py peek 2): the same rule on the forecasts that saw 2 future bars
    pk = os.path.join(pd_, 'peek2.npz')
    if os.path.exists(pk):
        z = np.load(pk); key = {(int(T), s): k for k, (T, s) in enumerate(zip(T_, S_))}
        ks = [key[(int(T), str(s))] for T, s in zip(z['T'], z['s'])]
        for H in HS:
            A = actual(H)[ks]; c0 = np.array(C0)[ks]
            for name, p in (('honest', PR[ks][:, :, H - 1]), ('peek2', z['p'][:, :, H - 3])):   # peek: bar i+H is step H−2
                m = np.median(p, 1) / c0 - 1; sg = np.where(m > 2 * COST, 1, np.where(m < -2 * COST, -1, 0)); sel = sg != 0
                R = np.array([trade(k, int(s_), H, False) for k, s_ in zip(np.array(ks)[sel], sg[sel])])
                res.setdefault('peek', {})[f'{name}|{H}'] = {'n': int(sel.sum()), 'hit': float(np.mean(np.sign(m) == np.sign(A))),
                                                             'mean': float(R.mean() * 100) if len(R) else None}
    json.dump(res, open(os.path.join(DATA, 'results.json'), 'w'), indent=1)
    report(res)

def report(res):
    f = lambda x, d=3: '—' if x is None else f'{x:+.{d}f}'
    print('\n| правило | H | k | выход | сделок | на сделку, % | до издержек, % | в плюс | t | 1-я половина | 2-я половина | случайные: среднее / 95-й проц. | лучше случайных |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for key, r in res['combos'].items():
        name, H, k, st = key.split('|')
        rnd = f"{f(r.get('rand_mean'))} / {f(r.get('rand_p95'))}" if 'rand_mean' in r else ''
        rk = f"{r['rand_rank'] * 100:.0f} %" if 'rand_rank' in r else ''
        win = '—' if r['win'] is None else f"{r['win'] * 100:.0f} %"
        print(f"| {name} | {H} | {k} | {st} | {r['n']} | {f(r['mean'])} | {f(r['gross'])} | {win} | {f(r['t'], 1)} | {f(r['halves'][0])} ({r['n_halves'][0]}) | {f(r['halves'][1])} ({r['n_halves'][1]}) | {rnd} | {rk} |")
    print('\n| H | прогноз | угадан знак | ранговая корреляция | по пятым частям |m|, итог в сторону прогноза до издержек, % |')
    print('|---|---|---|---|---|')
    for H, D in res['diag'].items():
        for name in ('kronos', 'naive_last_1h', 'naive_last_H'):
            d = D[name]; print(f"| {H} | {name} | {d['hit'] * 100:.1f} % | {d['rho']:+.3f} | {' / '.join(f'{x:+.3f}' for x in d['quint_gross_pct'])} |")
        print(f"| {H} | доля роста | {D['up_share'] * 100:.1f} % | | |")
    if 'peek' in res:
        print('\n', json.dumps(res['peek'], ensure_ascii=False))

if __name__ == '__main__':
    main()
