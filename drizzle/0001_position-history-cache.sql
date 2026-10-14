CREATE TABLE "position_history_state" (
	"position_mint" text PRIMARY KEY NOT NULL,
	"network" text DEFAULT 'mainnet-beta' NOT NULL,
	"program_id" text DEFAULT 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' NOT NULL,
	"context" jsonb NOT NULL,
	"head_signature" text,
	"backfill_before" text,
	"delta_before" text,
	"delta_head" text,
	"complete" boolean DEFAULT false NOT NULL,
	"parser_version" integer NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "position_history_state_identity_check" CHECK (network = 'mainnet-beta' AND program_id = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' AND position_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "position_history_state_context_check" CHECK (jsonb_typeof(context) = 'object' AND context->>'positionMint' = position_mint),
	CONSTRAINT "position_history_state_cursor_check" CHECK ((head_signature IS NULL OR head_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$') AND (backfill_before IS NULL OR backfill_before ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$') AND (delta_before IS NULL OR delta_before ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$') AND (delta_head IS NULL OR delta_head ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')),
	CONSTRAINT "position_history_state_versions_check" CHECK (parser_version > 0 AND revision BETWEEN 0 AND 9007199254740991 AND lease_epoch BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "position_history_state_lease_check" CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "position_history_transactions" (
	"position_mint" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" bigint,
	"status" text NOT NULL,
	"receipt" jsonb,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parser_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "position_history_transactions_pkey" PRIMARY KEY("position_mint","signature"),
	CONSTRAINT "position_history_transactions_signature_check" CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "position_history_transactions_slot_check" CHECK (slot BETWEEN 0 AND 9007199254740991 AND (block_time IS NULL OR block_time >= 0)),
	CONSTRAINT "position_history_transactions_status_check" CHECK (status IN ('parsed', 'pending', 'failed', 'ignored') AND parser_version > 0),
	CONSTRAINT "position_history_transactions_receipt_check" CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
	CONSTRAINT "position_history_transactions_events_check" CHECK (jsonb_typeof(events) = 'array' AND (status <> 'ignored' OR events = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "position_history_transactions" ADD CONSTRAINT "position_history_transactions_position_fkey" FOREIGN KEY ("position_mint") REFERENCES "public"."position_history_state"("position_mint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "position_history_transactions_position_slot_idx" ON "position_history_transactions" USING btree ("position_mint","slot");