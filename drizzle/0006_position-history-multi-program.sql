-- Position history cache: accept Meteora DLMM positions next to Raydium CLMM (P1). Only widens the CHECK; no row changes.
-- NOT VALID + VALIDATE keeps the check-scan separate from the catalog swap; every existing (Raydium) row passes.
-- Down (manual; drizzle has no down migrations): docs/ops/0006-position-history-multi-program-down.sql
ALTER TABLE "position_history_state" DROP CONSTRAINT "position_history_state_identity_check";--> statement-breakpoint
ALTER TABLE "position_history_state" ADD CONSTRAINT "position_history_state_identity_check" CHECK (network = 'mainnet-beta' AND program_id IN ('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo') AND position_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "position_history_state" VALIDATE CONSTRAINT "position_history_state_identity_check";
