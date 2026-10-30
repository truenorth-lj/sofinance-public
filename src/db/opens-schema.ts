import { sql } from "drizzle-orm";
import { index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Preserve the existing opens-log layout, including its timestamp default. */
export const positionOpens = pgTable("sofinance_position_opens", {
  txSignature: text("tx_signature").primaryKey(),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "string" }).notNull().default(sql`timezone('utc', now())`),
  wallet: text("wallet").notNull(),
  poolAddress: text("pool_address").notNull(),
  symbolA: text("symbol_a"),
  symbolB: text("symbol_b"),
  notionalUsd: numeric("notional_usd"),
  sourceRef: text("source_ref"),
}, table => [
  index("sofinance_position_opens_opened_at_idx").on(table.openedAt),
  index("sofinance_position_opens_wallet_idx").on(table.wallet, table.openedAt),
]);
