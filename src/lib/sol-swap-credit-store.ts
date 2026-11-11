import "server-only";
import type postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { getRwaConfig } from "./config/rwa-env";
import { assertRwaDatabaseIdentity, getRwaDatabase, runRwaDatabaseRequest } from "./rwa-database";

const { solSwapFeeCredits: credits } = schema;

/** The step-2 open a step-1 swap's fee credit is currently bound to. */
export type SolSwapCreditClaim = { swapSignature: string; wallet: string; openBlockhash: string; openLastValidBlockHeight: number };
export type SolSwapCreditClaimResult = { claimed: true } | { claimed: false; existing: SolSwapCreditClaim };

export interface SolSwapCreditStore {
  /** Inserts the first claim of a swap; returns the existing claim instead when the swap already has one. */
  claim(input: SolSwapCreditClaim): Promise<SolSwapCreditClaimResult>;
  /** Moves the claim to a new open only while it is still bound to `previousBlockhash` (compare-and-set). */
  reclaim(input: SolSwapCreditClaim & { previousBlockhash: string }): Promise<boolean>;
}

export class SolSwapCreditStoreUnavailableError extends Error {
  constructor() { super("SOL swap credit store unavailable"); this.name = "SolSwapCreditStoreUnavailableError"; }
}

export class PostgresSolSwapCreditStore implements SolSwapCreditStore {
  private readonly orm: PostgresJsDatabase<typeof schema>;
  constructor(public readonly db: postgres.Sql) { this.orm = drizzle(db, { schema }); }

  async claim(input: SolSwapCreditClaim): Promise<SolSwapCreditClaimResult> {
    await assertRwaDatabaseIdentity(this.db);
    const inserted = await this.orm.insert(credits).values(input).onConflictDoNothing({ target: credits.swapSignature })
      .returning({ swapSignature: credits.swapSignature });
    if (inserted.length) return { claimed: true };
    const [existing] = await this.orm.select({
      swapSignature: credits.swapSignature, wallet: credits.wallet,
      openBlockhash: credits.openBlockhash, openLastValidBlockHeight: credits.openLastValidBlockHeight,
    }).from(credits).where(eq(credits.swapSignature, input.swapSignature));
    // Inserted and read in two statements; a row that vanished in between is not a claim we can reason about.
    if (!existing) throw new SolSwapCreditStoreUnavailableError();
    return { claimed: false, existing };
  }

  async reclaim(input: SolSwapCreditClaim & { previousBlockhash: string }): Promise<boolean> {
    await assertRwaDatabaseIdentity(this.db);
    const updated = await this.orm.update(credits).set({
      openBlockhash: input.openBlockhash, openLastValidBlockHeight: input.openLastValidBlockHeight,
      claims: sql`${credits.claims} + 1`, lastClaimedAt: sql`clock_timestamp()`,
    }).where(and(eq(credits.swapSignature, input.swapSignature), eq(credits.wallet, input.wallet),
      eq(credits.openBlockhash, input.previousBlockhash))).returning({ swapSignature: credits.swapSignature });
    return updated.length === 1;
  }
}

let direct: { db: ReturnType<typeof getRwaDatabase>; store: SolSwapCreditStore } | undefined;

/**
 * The fee-credit ledger, always the database directly (there is no gateway route for it). Fails closed: without a
 * database the step-2 fee waiver is refused, never granted unrecorded.
 */
export function getSolSwapCreditStore(): SolSwapCreditStore {
  if (!getRwaConfig().databaseUrl) throw new SolSwapCreditStoreUnavailableError();
  let db: ReturnType<typeof getRwaDatabase>;
  try { db = getRwaDatabase(); } catch { throw new SolSwapCreditStoreUnavailableError(); }
  if (!direct || direct.db !== db) {
    const store = new PostgresSolSwapCreditStore(db);
    const guarded = <T>(work: () => Promise<T>) => runRwaDatabaseRequest(db, work).catch((error: unknown) => {
      throw error instanceof SolSwapCreditStoreUnavailableError ? error : new SolSwapCreditStoreUnavailableError();
    });
    direct = { db, store: {
      claim: (input) => guarded(() => store.claim(input)),
      reclaim: (input) => guarded(() => store.reclaim(input)),
    } };
  }
  return direct.store;
}
