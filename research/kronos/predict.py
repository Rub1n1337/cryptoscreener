# Step 2 of the Kronos stand (docs/RESEARCH-KRONOS.md): Kronos-small forecasts on the honest top-20, every 12 h of the test.
#
# Setup (once; everything downloaded lives in research/kronos/.ext/, git-ignored):
#   Python 3.11 (winget install Python.Python.3.11 --scope user), then
#   python -m venv research/kronos/.ext/venv
#   research/kronos/.ext/venv/Scripts/python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu126
#   research/kronos/.ext/venv/Scripts/python.exe -m pip install numpy pandas==2.2.2 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm==4.67.1
#   git clone --depth 1 https://github.com/shiyu-coder/Kronos research/kronos/.ext/Kronos      (used: model/ only; read 67b630e)
#   weights (safetensors + config only):
#   research/kronos/.ext/venv/Scripts/python.exe -I -c "from huggingface_hub import snapshot_download as d; [d(r, local_dir='research/kronos/.ext/hf/'+r.split('/')[1], allow_patterns=['*.safetensors','*.json']) for r in ['NeoQuasar/Kronos-small','NeoQuasar/Kronos-Tokenizer-base']]"
# Run (from the repo root; -I keeps the downloaded folders off the import path except model/ added below):
#   .../python.exe -I -u research/kronos/data.py                 candles (step 1)
#   .../python.exe -I -u research/kronos/predict.py              all forecasts, ~4 h on an RTX 3070 Laptop; resumes by month
#   .../python.exe -I -u research/kronos/predict.py cut 40       40 random points again on candles cut at T: must match
#   .../python.exe -I -u research/kronos/predict.py peek 2       every 20th point with the context moved 2 bars into the future
#   .../python.exe -I -u research/kronos/evaluate.py             tables (step 3)
#
# A forecast at the close T: for every pair of the honest top-20 at T (common.eligible_at), the last CTX = 512 closed 1h bars
# (open time < T) — open, high, low, close, volume, amount = quote turnover — normalised and clipped as KronosPredictor
# .predict_batch does, SAMPLES = 8 sample paths of PRED = 12 bars (T = 1, top_p = 0.9, the predictor's defaults), each path
# kept (predict_batch would average them). Seed per point. Saved: research/data/kronos/pred/<YYYY-MM>.npz.
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from common import *
sys.path.insert(0, os.path.join(EXT, 'Kronos'))
import torch
from model.kronos import Kronos, KronosTokenizer, auto_regressive_inference

torch.backends.cuda.matmul.allow_tf32 = False   # plain fp32, as the model was published
DEV = 'cuda:0' if torch.cuda.is_available() else 'cpu'
if DEV != 'cpu':
    # on Windows a GPU that runs out of memory spills into system RAM and gets ~9× slower instead of failing: PyTorch's cache
    # grew to ~7 GB of the 8 on batches of 17–20 pairs. A cap makes it fail loudly; the cache is emptied after each point.
    torch.cuda.set_per_process_memory_fraction(0.6)
PRED_DIR = os.path.join(DATA, 'pred')

def stamps(ms):
    d = np.array(ms, dtype='datetime64[ms]')
    Y, M, D = [d.astype(f'datetime64[{u}]') for u in ('Y', 'M', 'D')]
    minute = (d.astype('datetime64[m]') - d.astype('datetime64[h]')).astype(int)
    hour = (d.astype('datetime64[h]') - D).astype(int)
    weekday = (D.astype(np.int64) + 3) % 7            # 1970-01-01 was a Thursday; Monday = 0 as pandas .dt.weekday
    day = (D - M).astype(int) + 1
    month = (M - Y).astype(int) + 1
    return np.stack([minute, hour, weekday, day, month], -1).astype(np.float32)   # calc_time_stamps column order

def load_model():
    tok = KronosTokenizer.from_pretrained(os.path.join(EXT, 'hf', 'Kronos-Tokenizer-base')).to(DEV).eval()
    mod = Kronos.from_pretrained(os.path.join(EXT, 'hf', 'Kronos-small')).to(DEV).eval()
    return tok, mod

def forecast(tok, mod, C, T, items, peek=0, seed=None):
    """items [(sym, i)] -> closes (n, SAMPLES, PRED) float32. peek > 0: a deliberate look-ahead (the window ends peek bars
    after i) — only to see that the checks catch one."""
    X, XS, YS, mu, sd = [], [], [], [], []
    for s, i in items:
        K = C[s]; j = i + peek
        x = np.stack([K[k][j - CTX + 1:j + 1] for k in ('o', 'h', 'l', 'c', 'v', 'q')], -1).astype(np.float32)
        m, v = x.mean(0), x.std(0)
        X.append(np.clip((x - m) / (v + 1e-5), -5, 5)); mu.append(m); sd.append(v)
        XS.append(stamps(K['t'][j - CTX + 1:j + 1]))
        YS.append(stamps(K['t'][j] + HOUR * np.arange(1, PRED + 1)))
    rep = lambda a: torch.from_numpy(np.repeat(np.stack(a), SAMPLES, 0)).to(DEV)   # each path its own row: rows k*S … k*S+S-1
    torch.manual_seed(seed if seed is not None else T // STEP)
    z = auto_regressive_inference(tok, mod, rep(X), rep(XS), rep(YS), CTX, PRED, 5, 1.0, 0, 0.9, 1)   # (n*S, CTX, 6) — sample_count 1: no averaging
    z = z[:, -PRED:, 3].reshape(len(items), SAMPLES, PRED)
    if DEV != 'cpu': torch.cuda.empty_cache()
    mu, sd = np.array(mu)[:, 3], np.array(sd)[:, 3]
    return (z * (sd[:, None, None] + 1e-5) + mu[:, None, None]).astype(np.float32)

def load_all():
    P = json.load(open(os.path.join(DATA, 'pool.json')))['pool']
    return {s: load(s) for s in P}

def run_all():
    os.makedirs(PRED_DIR, exist_ok=True)
    C = load_all(); tok, mod = load_model()
    by_month = {}
    for T in points(): by_month.setdefault(month_of(T), []).append(T)
    t0 = time.time(); done = 0; total = len(points())
    for m, Ts in by_month.items():
        f = os.path.join(PRED_DIR, m + '.npz')
        if os.path.exists(f): done += len(Ts); continue
        rT, rS, rC0, rP, drop = [], [], [], [], []
        for T in Ts:
            items, dr = eligible_at(C, T); drop.append(dr)
            if items:
                p = forecast(tok, mod, C, T, items)
                for (s, i), pp in zip(items, p):
                    rT.append(T); rS.append(s); rC0.append(C[s]['c'][i]); rP.append(pp)
            done += 1
        np.savez(f, T=np.array(rT, np.int64), s=np.array(rS), c0=np.array(rC0), p=np.array(rP), drop_T=np.array(Ts, np.int64), drop=np.array(drop))
        el = time.time() - t0
        print(f'{m}: {len(rT)} forecasts, {sum(drop)} top pairs without 21 days of history; {done}/{total} points, {el / 60:.0f} min', flush=True)

def saved():
    out = {}
    for f in sorted(os.listdir(PRED_DIR)):
        if f.endswith('.npz') and len(f) == 11:
            z = np.load(os.path.join(PRED_DIR, f))
            for T, s, p in zip(z['T'], z['s'], z['p']): out[(int(T), str(s))] = p
    return out

def cut_check(n):
    """n random points again, on candles physically cut at T (no bar with open >= T exists) — must equal the stored run."""
    C = load_all(); tok, mod = load_model(); S = saved()
    Ts = sorted({T for T, _ in S}); rng = np.random.default_rng(7)
    worst = 0.0; diff_sets = 0
    for T in rng.choice(Ts, n, replace=False):
        T = int(T)
        Cc = {s: {k: v[:np.searchsorted(K['t'], T)] for k, v in K.items()} for s, K in C.items()}
        items, _ = eligible_at(Cc, T)
        stored = [(s, i) for s, i in eligible_at(C, T)[0]]
        if items != stored: diff_sets += 1; continue
        p = forecast(tok, mod, Cc, T, items)
        for (s, i), pp in zip(items, p):
            worst = max(worst, float(np.max(np.abs(pp / S[(T, s)] - 1))))
    print(f'cut check: {n} points, top differs at {diff_sets}, largest relative difference of a forecast {worst:.2e}')

def peek_run(shift):
    C = load_all(); tok, mod = load_model()
    rT, rS, rP = [], [], []
    for T in points()[::20]:
        items, _ = eligible_at(C, T)
        items = [(s, i) for s, i in items if i + shift < len(C[s]['t'])]
        if not items: continue
        p = forecast(tok, mod, C, T, items, peek=shift)
        for (s, i), pp in zip(items, p): rT.append(T); rS.append(s); rP.append(pp)
    np.savez(os.path.join(PRED_DIR, f'peek{shift}.npz'), T=np.array(rT, np.int64), s=np.array(rS), p=np.array(rP))
    print('peek', shift, len(rT), 'forecasts')

if __name__ == '__main__':
    a = sys.argv[1:]
    if not a: run_all()
    elif a[0] == 'cut': cut_check(int(a[1]))
    elif a[0] == 'peek': peek_run(int(a[1]))
