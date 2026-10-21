export const OPENS_TABLE = "sofinance_position_opens";

export const OPENS_CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sofinance_position_opens (
  tx_signature text PRIMARY KEY,
  opened_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  wallet text NOT NULL,
  pool_address text NOT NULL,
  symbol_a text,
  symbol_b text,
  notional_usd numeric,
  source_ref text
)`;

export const OPENS_CREATE_OPENED_AT_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS sofinance_position_opens_opened_at_idx ON sofinance_position_opens (opened_at)";

export const OPENS_CREATE_WALLET_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS sofinance_position_opens_wallet_idx ON sofinance_position_opens (wallet, opened_at)";

export const OPENS_DDL_STATEMENTS = [
  OPENS_CREATE_TABLE_SQL,
  OPENS_CREATE_OPENED_AT_INDEX_SQL,
  OPENS_CREATE_WALLET_INDEX_SQL,
] as const;
