CREATE TABLE "rwa_token_icon" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"image" text NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "rwa_token_icon_pkey" PRIMARY KEY("chain","address"),
	CONSTRAINT "rwa_token_icon_chain_check" CHECK (chain IN ('solana', 'robinhood')),
	CONSTRAINT "rwa_token_icon_address_check" CHECK ((chain = 'solana' AND address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND address ~ '^0x[0-9a-f]{40}$')),
	CONSTRAINT "rwa_token_icon_image_check" CHECK (image ~ '^https://' AND length(image) <= 1024),
	CONSTRAINT "rwa_token_icon_source_check" CHECK (source IN ('jupiter', 'raydium', 'dexscreener', 'geckoterminal', 'manual'))
);
