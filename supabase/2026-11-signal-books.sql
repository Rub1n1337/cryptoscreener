-- The order book at the shared bot's signals (docs/PLAN-V3.md stage 3, docs/PLAN-WALLS.md; the owner's «да» 09.11.2026).
-- One row per confirmed signal in the shared bot's pool (coin + timeframe + touch candle): one spot snapshot of Binance's book
-- (1000 levels) taken by the bot function in the run that first sees the signal confirmed (M.tradeRow(r).rev). What the price
-- did next is not stored: research reads it from the candles. Market data only, nothing about visitors.
-- No public read or write: only the service role (the bot function) touches it; research reads it with SQL.
-- ~200–400 bytes a row, tens of rows a day.

create table if not exists public.signal_books (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),                    -- when the snapshot was taken
  sym text not null,
  tf text not null,                                         -- the shared bot's timeframe then
  side text not null check (side in ('low', 'up')),         -- low: LONG off the lower band, up: SHORT off the upper
  touch_time bigint not null,                               -- the touch candle's open time, ms (one row per signal)
  score smallint,                                           -- strength on the closed candle
  price double precision not null,                          -- the book's middle when taken
  lo double precision, mid double precision, up double precision,   -- the channel on the closed candle
  wanted boolean not null,                                  -- passes the shared bot's rules (M.wants)
  entered boolean not null,                                 -- the shared bot opened a position on it in that run
  reach double precision,                                   -- how far the snapshot reached from the middle (share, shorter side)
  bid05 double precision, bid1 double precision, bid2 double precision,   -- $ of bids within 0.5 / 1 / 2 % below the middle
  ask05 double precision, ask1 double precision, ask2 double precision,   -- $ of asks within 0.5 / 1 / 2 % above it
  walls jsonb not null default '[]'::jsonb,                 -- M.wallsOf with M.WALL: [{price, usd, side}]
  unique (sym, tf, touch_time)
);

alter table public.signal_books enable row level security;
-- Supabase grants anon and authenticated everything on a new table in public by default (LESSONS.md): take it back
revoke all on table public.signal_books from anon, authenticated;

notify pgrst, 'reload schema';
