CREATE TABLE "rwa_meteora_tvl_daily" (
	"pool_address" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"tvl_usd" numeric NOT NULL,
	"captured_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "rwa_meteora_tvl_daily_pkey" PRIMARY KEY("pool_address","snapshot_date"),
	CONSTRAINT "rwa_meteora_tvl_daily_pool_address_check" CHECK (pool_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "rwa_meteora_tvl_daily_tvl_usd_check" CHECK (tvl_usd >= 0)
);
