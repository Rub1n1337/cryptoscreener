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

Memory: about 30–60 MB for 20 coins with a day of history; the volume holds about the same on disk.
