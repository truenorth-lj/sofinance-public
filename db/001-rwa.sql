-- SoFinance RWA schema v1. Apply as role sofinance to database sofinance.
-- Contains no credentials. Runtime/API/background-refresh integration is separate.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DO $$ BEGIN
  IF current_database() <> 'sofinance' OR current_user <> 'sofinance' THEN
    RAISE EXCEPTION 'Apply this schema only as sofinance in database sofinance';
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO sofinance;

CREATE TABLE public.rwa_feed_state (
  feed_key text PRIMARY KEY CHECK (length(btrim(feed_key)) > 0),
  generation_id uuid,
  scan_max_pages integer NOT NULL DEFAULT 10 CHECK (scan_max_pages BETWEEN 1 AND 30),
  pages_fetched integer NOT NULL DEFAULT 0 CHECK (pages_fetched BETWEEN 0 AND scan_max_pages),
  scanned_pools integer NOT NULL DEFAULT 0 CHECK (scanned_pools >= 0),
  page_pool_counts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(page_pool_counts) = 'array'),
  published_at timestamptz,
  qualification_observed_at jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qualification_observed_at) = 'object'),
  pairing_rule_version text NOT NULL CHECK (length(btrim(pairing_rule_version)) > 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  CHECK ((generation_id IS NULL) = (published_at IS NULL))
);

CREATE TABLE public.rwa_pool_latest (
  pool_address text PRIMARY KEY CHECK (pool_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  feed_key text NOT NULL REFERENCES public.rwa_feed_state(feed_key) ON DELETE RESTRICT,
  mint_a text NOT NULL CHECK (mint_a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  mint_b text NOT NULL CHECK (mint_b ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  symbol_a text NOT NULL CHECK (length(btrim(symbol_a)) > 0),
  symbol_b text NOT NULL CHECK (length(btrim(symbol_b)) > 0),
  tvl_usd numeric CHECK (tvl_usd >= 0 AND tvl_usd < 'Infinity'::numeric),
  volume_24h_usd numeric CHECK (volume_24h_usd >= 0 AND volume_24h_usd < 'Infinity'::numeric),
  fees_24h_usd numeric CHECK (fees_24h_usd >= 0 AND fees_24h_usd < 'Infinity'::numeric),
  fee_rate numeric CHECK (fee_rate >= 0 AND fee_rate <= 1),
  pool_fee_apr_pct numeric CHECK (pool_fee_apr_pct >= 0 AND pool_fee_apr_pct < 'Infinity'::numeric),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  source_page integer NOT NULL CHECK (source_page BETWEEN 1 AND 30),
  last_seen_generation uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metrics_observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX rwa_pool_latest_feed_generation_page_idx
  ON public.rwa_pool_latest(feed_key, last_seen_generation, source_page);

CREATE TABLE public.rwa_apr_latest (
  pool_address text PRIMARY KEY REFERENCES public.rwa_pool_latest(pool_address) ON DELETE RESTRICT,
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  payload_snapshot_at timestamptz,
  chain_observed_at timestamptz,
  economics_observed_at timestamptz,
  volume_observed_at timestamptz,
  payload_schema_version integer NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  algorithm_version text NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  reference_capital_usd numeric NOT NULL DEFAULT 100 CHECK (reference_capital_usd > 0 AND reference_capital_usd < 'Infinity'::numeric),
  profile_cache jsonb CHECK (profile_cache IS NULL OR jsonb_typeof(profile_cache) = 'object'),
  last_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_status text NOT NULL CHECK (last_attempt_status IN ('ok', 'degraded', 'error')),
  last_attempt_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(last_attempt_issues) = 'array'),
  CHECK ((payload IS NULL) = (payload_snapshot_at IS NULL)),
  CHECK (payload IS NULL OR (payload ? 'poolId' AND payload->>'poolId' = pool_address))
);

CREATE TABLE public.rwa_apr_daily (
  pool_address text NOT NULL REFERENCES public.rwa_pool_latest(pool_address) ON DELETE RESTRICT,
  snapshot_date date NOT NULL,
  scheduled_for timestamptz NOT NULL,
  captured_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'degraded', 'failed', 'missing')),
  mint_a text NOT NULL CHECK (mint_a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  mint_b text NOT NULL CHECK (mint_b ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  symbol_a text NOT NULL CHECK (length(btrim(symbol_a)) > 0),
  symbol_b text NOT NULL CHECK (length(btrim(symbol_b)) > 0),
  tvl_usd numeric CHECK (tvl_usd >= 0 AND tvl_usd < 'Infinity'::numeric),
  volume_24h_usd numeric CHECK (volume_24h_usd >= 0 AND volume_24h_usd < 'Infinity'::numeric),
  fees_24h_usd numeric CHECK (fees_24h_usd >= 0 AND fees_24h_usd < 'Infinity'::numeric),
  pool_fee_apr_pct numeric CHECK (pool_fee_apr_pct >= 0 AND pool_fee_apr_pct < 'Infinity'::numeric),
  pool_metrics_observed_at timestamptz,
  highest_range_apr_pct numeric CHECK (highest_range_apr_pct >= 0 AND highest_range_apr_pct < 'Infinity'::numeric),
  highest_range_id text CHECK (highest_range_id IN ('micro', 'tight', 'standard', 'wide')),
  tick_lower integer,
  tick_upper integer,
  price_lower numeric CHECK (price_lower > 0 AND price_lower < 'Infinity'::numeric),
  price_upper numeric CHECK (price_upper > 0 AND price_upper < 'Infinity'::numeric),
  presets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(presets) = 'array'),
  reference_capital_usd numeric NOT NULL DEFAULT 100 CHECK (reference_capital_usd > 0 AND reference_capital_usd < 'Infinity'::numeric),
  algorithm_version text NOT NULL CHECK (length(btrim(algorithm_version)) > 0),
  payload_schema_version integer NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  chain_observed_at timestamptz,
  economics_observed_at timestamptz,
  volume_observed_at timestamptz,
  sample jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sample) = 'object'),
  failure_reason text,
  finalized_at timestamptz,
  PRIMARY KEY (pool_address, snapshot_date),
  CHECK (snapshot_date = (scheduled_for AT TIME ZONE 'Asia/Taipei')::date),
  CHECK ((tick_lower IS NULL) = (tick_upper IS NULL)),
  CHECK (tick_lower IS NULL OR tick_lower < tick_upper),
  CHECK ((price_lower IS NULL) = (price_upper IS NULL)),
  CHECK (price_lower IS NULL OR price_lower < price_upper),
  CHECK (captured_at IS NULL OR captured_at >= scheduled_for),
  CHECK (status <> 'pending' OR finalized_at IS NULL),
  CHECK (status = 'pending' OR finalized_at IS NOT NULL),
  CHECK (status <> 'ok' OR (
    highest_range_apr_pct IS NOT NULL AND highest_range_id IS NOT NULL
    AND tick_lower IS NOT NULL AND price_lower IS NOT NULL
    AND captured_at IS NOT NULL
  )),
  CHECK (status = 'ok' OR (
    highest_range_apr_pct IS NULL AND highest_range_id IS NULL
    AND tick_lower IS NULL AND tick_upper IS NULL
    AND price_lower IS NULL AND price_upper IS NULL
  ))
);
CREATE INDEX rwa_apr_daily_date_pool_idx ON public.rwa_apr_daily(snapshot_date, pool_address);

CREATE TABLE public.background_job_state (
  job_key text PRIMARY KEY CHECK (length(btrim(job_key)) > 0),
  lease_owner uuid,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  next_due_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_success_at timestamptz,
  last_status text NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle', 'running', 'ok', 'partial', 'error')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_duration_ms integer CHECK (last_duration_ms >= 0),
  last_error jsonb CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
  last_summary jsonb CHECK (last_summary IS NULL OR jsonb_typeof(last_summary) = 'object'),
  progress jsonb CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object'),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (last_status <> 'running' OR lease_owner IS NOT NULL)
);

COMMENT ON TABLE public.rwa_feed_state IS 'Published RWA discovery generation and scan coverage';
COMMENT ON TABLE public.rwa_pool_latest IS 'Per-pool discovery snapshot; inactive generations retained';
COMMENT ON TABLE public.rwa_apr_latest IS 'Latest complete range APR payload and bounded worker profile cache';
COMMENT ON TABLE public.rwa_apr_daily IS 'At most one Taipei-dated observation per pool per day; unavailable APR is NULL';
COMMENT ON TABLE public.background_job_state IS 'Durable scheduling state and lease epochs; workers enforce fencing in transactions';
COMMIT;
