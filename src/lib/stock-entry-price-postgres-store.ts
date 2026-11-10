import "server-only";
import type postgres from "postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { assertRwaDatabaseIdentity } from "./rwa-database";
import {
  entryPriceRowSchema, entryPriceStoreRequestSchema, isReusableEntryPriceRow, StockEntryPriceStoreError,
  type EntryPriceStoreOperation, type EntryPriceStoreRequest, type EntryPriceStoreResultMap, type StockEntryPriceRow, type StockEntryPriceStore,
} from "./stock-entry-price-store-types";

const { positionEntryPrices: prices } = schema;

/** One row per deposit: insert once; replace only an older `no_trade` (leave `ok` alone). */
export class PostgresStockEntryPriceStore implements StockEntryPriceStore {
  private readonly orm: PostgresJsDatabase<typeof schema>;
  constructor(public readonly db: postgres.Sql) { this.orm = drizzle(db, { schema }); }

  async request<K extends EntryPriceStoreOperation>(raw: EntryPriceStoreRequest<K>): Promise<EntryPriceStoreResultMap[K]> {
    const input = entryPriceStoreRequestSchema.parse(raw) as EntryPriceStoreRequest;
    await assertRwaDatabaseIdentity(this.db);
    // The op narrows the result; the assertion keeps that generic relationship.
    return (input.op === "read" ? await this.read(input) : await this.write(input)) as EntryPriceStoreResultMap[K];
  }

  private async read(input: EntryPriceStoreRequest<"read">): Promise<StockEntryPriceRow[]> {
    const rows = await this.orm.select().from(prices).where(and(eq(prices.priceMint, input.priceMint),
      inArray(prices.depositSignature, input.signatures)));
    return rows.flatMap((row) => {
      const parsed = entryPriceRowSchema.safeParse({ depositSignature: row.depositSignature, priceMint: row.priceMint,
        depositSlot: row.depositSlot, depositBlockTime: row.depositBlockTime, referencePool: row.referencePool,
        methodVersion: row.methodVersion, status: row.status, priceUsd: row.priceUsd, trades: row.trades });
      return parsed.success && isReusableEntryPriceRow(parsed.data, input.methodVersion) ? [parsed.data] : [];
    });
  }

  private async write(input: EntryPriceStoreRequest<"write">): Promise<number> {
    if (new Set(input.rows.map((row) => `${row.depositSignature}:${row.priceMint}`)).size !== input.rows.length)
      throw new StockEntryPriceStoreError("DUPLICATE_ENTRY_PRICE");
    const written = await this.orm.insert(prices).values(input.rows.map((row) => ({ ...row, computedAt: sql`clock_timestamp()` })))
      .onConflictDoUpdate({
        target: [prices.depositSignature, prices.priceMint],
        set: { depositSlot: sql`excluded.deposit_slot`, depositBlockTime: sql`excluded.deposit_block_time`,
          referencePool: sql`excluded.reference_pool`, status: sql`excluded.status`, priceUsd: sql`excluded.price_usd`,
          trades: sql`excluded.trades`, methodVersion: sql`excluded.method_version`, computedAt: sql`excluded.computed_at` },
        setWhere: sql`${prices.methodVersion} < excluded.method_version AND ${prices.status} = 'no_trade'`,
      }).returning({ signature: prices.depositSignature });
    return written.length;
  }
}
