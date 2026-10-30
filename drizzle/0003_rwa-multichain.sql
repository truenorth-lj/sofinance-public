ALTER TABLE "rwa_apr_daily" DROP CONSTRAINT "rwa_apr_daily_mint_a_check";--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" DROP CONSTRAINT "rwa_apr_daily_mint_b_check";--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" DROP CONSTRAINT "rwa_pool_latest_mint_a_check";--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" DROP CONSTRAINT "rwa_pool_latest_mint_b_check";--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" DROP CONSTRAINT "rwa_pool_latest_pool_address_check";--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD COLUMN "chain" text DEFAULT 'solana' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD COLUMN "protocol" text DEFAULT 'raydium-clmm' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_apr_latest" ADD COLUMN "chain" text DEFAULT 'solana' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_apr_latest" ADD COLUMN "protocol" text DEFAULT 'raydium-clmm' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD COLUMN "chain" text DEFAULT 'solana' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD COLUMN "protocol" text DEFAULT 'raydium-clmm' NOT NULL;--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD CONSTRAINT "rwa_apr_daily_pool_address_check" CHECK ((chain = 'solana' AND pool_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND pool_address ~ '^0x[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD CONSTRAINT "rwa_apr_daily_chain_protocol_check" CHECK ((chain = 'solana' AND protocol IN ('raydium-clmm', 'orca-whirlpool', 'meteora-dlmm')) OR (chain = 'robinhood' AND protocol = 'uniswap-v4-rhc'));--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD CONSTRAINT "rwa_apr_daily_mint_a_check" CHECK ((chain = 'solana' AND mint_a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND mint_a ~ '^0x[0-9a-f]{40}$'));--> statement-breakpoint
ALTER TABLE "rwa_apr_daily" ADD CONSTRAINT "rwa_apr_daily_mint_b_check" CHECK ((chain = 'solana' AND mint_b ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND mint_b ~ '^0x[0-9a-f]{40}$'));--> statement-breakpoint
ALTER TABLE "rwa_apr_latest" ADD CONSTRAINT "rwa_apr_latest_pool_address_check" CHECK ((chain = 'solana' AND pool_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND pool_address ~ '^0x[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "rwa_apr_latest" ADD CONSTRAINT "rwa_apr_latest_chain_protocol_check" CHECK ((chain = 'solana' AND protocol IN ('raydium-clmm', 'orca-whirlpool', 'meteora-dlmm')) OR (chain = 'robinhood' AND protocol = 'uniswap-v4-rhc'));--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD CONSTRAINT "rwa_pool_latest_chain_protocol_check" CHECK ((chain = 'solana' AND protocol IN ('raydium-clmm', 'orca-whirlpool', 'meteora-dlmm')) OR (chain = 'robinhood' AND protocol = 'uniswap-v4-rhc'));--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD CONSTRAINT "rwa_pool_latest_mint_a_check" CHECK ((chain = 'solana' AND mint_a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND mint_a ~ '^0x[0-9a-f]{40}$'));--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD CONSTRAINT "rwa_pool_latest_mint_b_check" CHECK ((chain = 'solana' AND mint_b ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND mint_b ~ '^0x[0-9a-f]{40}$'));--> statement-breakpoint
ALTER TABLE "rwa_pool_latest" ADD CONSTRAINT "rwa_pool_latest_pool_address_check" CHECK ((chain = 'solana' AND pool_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR (chain = 'robinhood' AND pool_address ~ '^0x[0-9a-f]{64}$'));