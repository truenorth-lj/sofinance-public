CREATE TABLE "sol_swap_fee_credits" (
	"swap_signature" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"open_blockhash" text NOT NULL,
	"open_last_valid_block_height" bigint NOT NULL,
	"claims" integer DEFAULT 1 NOT NULL,
	"first_claimed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_claimed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "sol_swap_fee_credits_signature_check" CHECK (swap_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
	CONSTRAINT "sol_swap_fee_credits_keys_check" CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND open_blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
	CONSTRAINT "sol_swap_fee_credits_claim_check" CHECK (open_last_valid_block_height BETWEEN 0 AND 9007199254740991 AND claims > 0)
);
