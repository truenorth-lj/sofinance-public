-- Idempotent DDL for SoFinance north-star open logs.
-- Run against the database in SOFINANCE_OPENS_DATABASE_URL (Neon / Vercel Postgres).
-- The app also applies this on first write when the URL is set (best-effort, never on the user path).

CREATE TABLE IF NOT EXISTS sofinance_position_opens (
  tx_signature text PRIMARY KEY,
  opened_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  wallet text NOT NULL,
  pool_address text NOT NULL,
  symbol_a text,
  symbol_b text,
  notional_usd numeric,
  source_ref text
);

CREATE INDEX IF NOT EXISTS sofinance_position_opens_opened_at_idx
  ON sofinance_position_opens (opened_at);

CREATE INDEX IF NOT EXISTS sofinance_position_opens_wallet_idx
  ON sofinance_position_opens (wallet, opened_at);
