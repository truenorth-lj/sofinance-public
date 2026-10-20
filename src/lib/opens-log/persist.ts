import postgres from "postgres";
import { getOpensDatabaseUrl } from "@/lib/config/opens-env";
import { OPENS_DDL_STATEMENTS } from "./schema";
import type { PositionOpenRow } from "./types";
import { runBestEffort } from "./wait-until";

export type OpensSql = {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  end?(options?: { timeout?: number }): Promise<void>;
};

let cached: OpensSql | undefined;
let schemaReady = false;

export function resetOpensClientForTests() {
  cached = undefined;
  schemaReady = false;
}

export function getOpensSql(create: (url: string) => OpensSql = connectOpens): OpensSql | undefined {
  const url = getOpensDatabaseUrl();
  if (!url) return undefined;
  if (!cached) cached = create(url);
  return cached;
}

function connectOpens(url: string): OpensSql {
  return postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => {},
  });
}

export async function ensureOpensSchema(sql: OpensSql) {
  if (schemaReady) return;
  for (const statement of OPENS_DDL_STATEMENTS) await sql.unsafe(statement);
  schemaReady = true;
}

export function insertOpenSql(row: PositionOpenRow) {
  return {
    sql: `INSERT INTO sofinance_position_opens
      (tx_signature, wallet, pool_address, symbol_a, symbol_b, notional_usd, source_ref)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tx_signature) DO NOTHING`,
    params: [
      row.txSignature,
      row.wallet,
      row.poolAddress,
      row.symbolA,
      row.symbolB,
      row.notionalUsd,
      row.sourceRef,
    ] as unknown[],
  };
}

export async function persistPositionOpen(row: PositionOpenRow, sql = getOpensSql()) {
  if (!sql) return { skipped: true as const, inserted: false };
  await ensureOpensSchema(sql);
  const { sql: text, params } = insertOpenSql(row);
  await sql.unsafe(text, params);
  return { skipped: false as const, inserted: true };
}

/** Best-effort: never throws, never awaited by the broadcast response. */
export function logPositionOpenBestEffort(row: PositionOpenRow | null) {
  if (!row || !getOpensDatabaseUrl()) return;
  runBestEffort(persistPositionOpen(row));
}
