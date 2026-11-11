# Shared pieces of the Kronos stand (docs/RESEARCH-KRONOS.md): paths, the rules fixed before the run, costs read from math.js,
# the candle store (Cloudflare R2, the same files history.js reads) and the honest top. Imported by data.py / predict.py /
# evaluate.py; run nothing from here. Python 3.11 in research/kronos/.ext/venv (see predict.py for the setup).
import gzip, json, os, re, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
EXT = os.path.join(HERE, '.ext')                       # downloads: Kronos code, venv, weights (git-ignored)
DATA = os.path.join(ROOT, 'research', 'data', 'kronos')  # candles and forecasts (research/data/ is git-ignored)
BASE = 'https://pub-edb3115ccf904c00bd02f3372a9cb8d9.r2.dev'   # history.js BASE
API = 'https://data-api.binance.vision/api/v3'
HOUR, DAY = 3_600_000, 86_400_000

def utc(s): return int(datetime.strptime(s, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000)
def iso(ms): return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M')

# ---------- rules, fixed before the first forecast (docs/RESEARCH-KRONOS.md, «Правила до прогона») ----------
TEST0, TEST1 = utc('2024-07-01'), utc('2026-11-01')   # pre-training data ends June 2024 (paper, Appendix D)
HALF = utc('2025-09-01')                              # first half / second half (14 months each)
STEP = 12 * HOUR                                      # a forecast at every 00:00 and 12:00 UTC close
CTX = 512                                             # Kronos-small max context: 512 closed 1h bars (21.3 days)
PRED = 12                                             # bars forecast
HS = [4, 12]                                          # horizons (1h bars); the main one 12
KS = [1, 2, 4]                                        # threshold = k × round-trip cost; the main one 2
SAMPLES = 8                                           # sample paths per forecast; the signal is their median close
TOP = 20                                              # honest top-20 by 24 h quote turnover at the decision
POOL_TOP = 50                                         # pool: every pair ever in the daily top-50 of the period
STOP_ATR = 2.0                                        # the stop variant: 2 × ATR(14) of 1h from the entry
RUNS = 300                                            # random-entry runs
MAIN = (12, 2)

# ---------- costs: read from math.js, so they stay what the site and the bot use ----------
def _mathjs():
    src = open(os.path.join(ROOT, 'supabase', 'functions', '_shared', 'math.js'), encoding='utf-8').read()
    num = lambda k: float(re.search(r'export const %s = ([0-9.e-]+)' % k, src).group(1))
    stable = set(re.findall(r"'([A-Z0-9]+)'", re.search(r'export const STABLE = new Set\(\[([^\]]*)\]', src).group(1)))
    majors = re.search(r'export const MAJORS = \[([^\]]*)\]', src)
    return num('FEE'), num('SLIP'), num('BORROW_DAY'), stable, re.findall(r"'([A-Z0-9]+)'", majors.group(1)) if majors else []
FEE, SLIP, BORROW_DAY, STABLE, MAJORS = _mathjs()
COST = 2 * FEE + 2 * SLIP                             # round trip without the borrow: 0.25 %

# ---------- R2 ----------
def get(url, tries=5):
    for a in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'research-stand'}), timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404): return None
        except Exception: pass
        time.sleep(1.5 * (a + 1))
    raise RuntimeError('fetch failed ' + url)

def jgz(url):
    b = get(url)
    return None if b is None else json.loads(gzip.decompress(b))

def month_start(m): return utc(m + '-01')
def next_month(m): y, mo = int(m[:4]), int(m[5:]); return f'{y + mo // 12}-{mo % 12 + 1:02d}'
def months(a, b):
    out = []
    while a <= b: out.append(a); a = next_month(a)
    return out
def month_of(ms): return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m')

def candles_path(sym): return os.path.join(DATA, '1h', sym + '.npz')
def load(sym):
    z = np.load(candles_path(sym))
    return {k: z[k] for k in z.files}   # t (open time, ms, int64), o h l c v q (float64)

def eligible_at(C, T):
    """Pairs in the honest top-20 at the close T (= open time of the next bar), with the index of the last closed bar.
    Only bars with open time < T count; a pair in the top needs its last bar to be the one that closed at T. The top is
    ranked among all pairs trading at T; a pair of the top with fewer than CTX bars of history (listed < 21 days ago) is
    dropped, not replaced. Returns (kept [(sym, i)], dropped count)."""
    rows = []
    for s, K in C.items():
        i = np.searchsorted(K['t'], T) - 1          # last bar with open < T
        if i < 0 or K['t'][i] != T - HOUR: continue
        a = np.searchsorted(K['t'], T - DAY)
        rows.append((float(K['q'][a:i + 1].sum()), s, int(i)))
    rows.sort(reverse=True)
    top = rows[:TOP]
    kept = [(s, i) for _, s, i in top if i >= CTX - 1]
    return kept, len(top) - len(kept)

def points():
    return list(range(TEST0, TEST1, STEP))
