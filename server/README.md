# Sigma Radar collector

A small always-on service for the Beta tab. It keeps full Binance order books for the most traded coins (spot and USDⓈ-M futures), a day of
liquidity-heatmap history and trade clusters, and serves them over HTTP. No keys, no trading.

## Deploy on Railway

1. railway.com → **New Project** → **Deploy from GitHub repo** → pick `cryptoscreener`.
2. In the new service: **Settings** →
   - **Root Directory**: `server`
   - **Region**: an EU region (Amsterdam) or Southeast Asia — Binance refuses US IP addresses.
3. **Settings → Networking → Generate Domain** — this is the server address.
4. Optional **Variables**: `TOP` (how many spot coins, default 20), `TOP_FUT` (how many perpetual futures, default = `TOP`, 0 = spot only), `SYMBOLS` (exact list, e.g. `BTCUSDT,ETHUSDT`),
   `KEEP_MIN` (minutes of history, default 1440).
5. Open `https://<domain>/health` — after a minute every coin should show `"book": true`.
6. Keep history across restarts: attach a **Volume** to the service (any mount path, e.g. `/data`). Railway passes its
   path in `RAILWAY_VOLUME_MOUNT_PATH`; the logs then show `restored: …` after each restart. Without a volume the
   history lives in memory only.
7. **Settings → Build → Watch Paths**: `/server/**`, so site-only commits do not restart the collector.

Then put the domain into `SERVER` at the top of the server section in `beta.js` (or open the site once with
`?srv=https://<domain>`).

## API

| path | what |
|---|---|
| `/health` | coins followed, book readiness, minutes of history |
| `/symbols` | the followed symbols: `symbols` (spot) and `futures` |
| `/book?symbol=BTCUSDT` | the whole known book, binned by the coin's base step (≈0.05% of the price) |
| `/heat?symbol=BTCUSDT&since=<ms>` | heatmap columns, one per minute |
| `/fp?symbol=BTCUSDT&since=<ms>` | market buys / sells by price bin, one per minute |
| `/liq?symbol=BTCUSDT&since=<ms>` | futures liquidations by price bin, one per minute |

Add `&mkt=fut` to `/book`, `/heat` and `/fp` for the futures book and history (`/liq` is always futures).

## What it costs (Railway Hobby: $5 a month includes $5 of usage)

Railway bills RAM ($10 per GB a month), CPU ($20 per vCPU a month), egress ($0.05 per GB) and the volume ($0.15 per GB a month)
by the minute; incoming traffic is free. `/health` → `res` shows what the service uses right now:

| field | what |
|---|---|
| `cpu` | share of one vCPU over the last minute |
| `loop` | share of that minute the main thread was busy |
| `msgPerS`, `kbPerS` | messages and KB per second taken from Binance |
| `msMin` | ms per minute spent on stream messages, heatmap samples, pruning, GC |
| `outKbMin` | egress per route, KB per minute |
| `rssMb`, `heapMb`, `heapTotalMb`, `buffersMb` | memory: the whole process, the JS heap, typed arrays (history) |
| `scan` | the bot's candle series, and per minute `/scan` calls, analyses, their time, Binance requests |

Measured 29.10.2026 (20 spot + 20 futures coins, a day of history, ~590 candle series for the bot):

| | use | a month |
|---|---|---|
| CPU | ~0.11 vCPU (about 40% stream messages, the rest `/scan`, heatmap, GC, HTTP) | ~$2.2 |
| RAM | ~310 MB (heap ~110, history ~62 in typed arrays, the rest Node and buffers) | ~$3.1 |
| egress | `/scan` ~100–260 KB a minute gzipped; an open Beta chart ~90 KB a minute | ~$0.3–0.6 |
| volume | ~160 MB | ~$0.02 |

Each coin pair (spot + futures) is about 1/20 of the CPU and of the history memory. The book streams come once a second
(spot) and every 500 ms (futures): at 100 ms they cost several times the CPU for nothing the heatmap or `/book` could show.
