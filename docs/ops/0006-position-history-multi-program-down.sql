-- MANUAL DOWN for drizzle/0006_position-history-multi-program.sql (drizzle has no down migrations; never run automatically).
-- Restores the 0001 Raydium-only identity CHECK. Atomic: the guard, DROP and ADD commit together or not at all.
-- Refuses (and rolls back) while non-Raydium rows exist instead of deleting them; remove those rows, and their
-- position_history_transactions (FK is ON DELETE RESTRICT), deliberately first if a rollback is really wanted.
-- Also revert src/db/schema.ts and remove 0006 from drizzle/meta/_journal.json + the drizzle.__drizzle_migrations
-- ledger row in the same change, or the next db:migrate re-applies 0006 / reports a ledger mismatch.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.position_history_state WHERE program_id <> 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK') THEN
    RAISE EXCEPTION '0006 down: non-Raydium rows exist in position_history_state; remove them first';
  END IF;
END $$;
ALTER TABLE "position_history_state" DROP CONSTRAINT "position_history_state_identity_check";
ALTER TABLE "position_history_state" ADD CONSTRAINT "position_history_state_identity_check" CHECK (network = 'mainnet-beta' AND program_id = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' AND position_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
COMMIT;
-- Post-check: expect the Raydium-only definition, convalidated = true.
-- SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'public.position_history_state'::regclass AND conname = 'position_history_state_identity_check';
