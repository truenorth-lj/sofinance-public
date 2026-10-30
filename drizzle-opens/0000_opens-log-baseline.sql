CREATE TABLE "sofinance_position_opens" (
	"tx_signature" text PRIMARY KEY NOT NULL,
	"opened_at" timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
	"wallet" text NOT NULL,
	"pool_address" text NOT NULL,
	"symbol_a" text,
	"symbol_b" text,
	"notional_usd" numeric,
	"source_ref" text
);
--> statement-breakpoint
CREATE INDEX "sofinance_position_opens_opened_at_idx" ON "sofinance_position_opens" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "sofinance_position_opens_wallet_idx" ON "sofinance_position_opens" USING btree ("wallet","opened_at");