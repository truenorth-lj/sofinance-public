CREATE TABLE "position_entry_prices" (
	"deposit_signature" text NOT NULL,
	"price_mint" text NOT NULL,
	"deposit_slot" bigint NOT NULL,
	"deposit_block_time" bigint NOT NULL,
	"reference_pool" text NOT NULL,
	"status" text NOT NULL,
	"price_usd" numeric,
	"trades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"method_version" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "position_entry_prices_pkey" PRIMARY KEY("deposit_signature","price_mint"),
	CONSTRAINT "position_entry_prices_signature_check" CHECK (deposit_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "position_entry_prices_keys_check" CHECK (price_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND reference_pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "position_entry_prices_deposit_check" CHECK (deposit_slot BETWEEN 0 AND 9007199254740991 AND deposit_block_time >= 0 AND method_version > 0),
	CONSTRAINT "position_entry_prices_status_check" CHECK ((status = 'ok' AND price_usd IS NOT NULL AND price_usd > 0 AND price_usd < 'Infinity'::numeric) OR (status = 'no_trade' AND price_usd IS NULL)),
	CONSTRAINT "position_entry_prices_trades_check" CHECK (jsonb_typeof(trades) = 'array' AND jsonb_array_length(trades) <= 3 AND (status = 'ok' OR trades = '[]'::jsonb))
);
