import { getOpensSql, type OpensSql } from "./persist";
import { aggregateOpensDaily, opensDailyCsv } from "./aggregate";
import type { DailyOpens, OpenLogRecord } from "./types";

const MS_PER_DAY = 86_400_000;

export function opensRange(now = Date.now(), days = 90) {
  const span = Number.isInteger(days) ? Math.min(366, Math.max(1, days)) : 90;
  const to = new Date(Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  ));
  const from = new Date(to.getTime() - span * MS_PER_DAY);
  return { from, to, days: span };
}

function utcDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function recordsFromOpenRows(rows: Array<{
  opened_at: string | Date;
  wallet: string;
  source_ref: string | null;
  notional_usd: string | number | null;
}>): OpenLogRecord[] {
  return rows.map((row) => {
    const opened = row.opened_at instanceof Date ? row.opened_at : new Date(row.opened_at);
    const notional = row.notional_usd === null || row.notional_usd === undefined ? null : Number(row.notional_usd);
    return {
      day: utcDay(opened),
      wallet: row.wallet,
      ref: row.source_ref,
      notionalUsd: notional !== null && Number.isFinite(notional) ? notional : null,
      openedAtMs: opened.getTime(),
    };
  });
}

export async function queryOpensDaily(options: { days?: number; now?: number; sql?: OpensSql } = {}): Promise<{
  configured: boolean;
  days: DailyOpens[];
  range: { from: string; to: string };
}> {
  const range = opensRange(options.now, options.days);
  const sql = options.sql ?? getOpensSql();
  if (!sql) {
    return { configured: false, days: [], range: { from: range.from.toISOString(), to: range.to.toISOString() } };
  }
  const rows = await sql.unsafe(
    `SELECT opened_at, wallet, source_ref, notional_usd
     FROM sofinance_position_opens
     WHERE opened_at >= $1 AND opened_at < $2`,
    [range.from.toISOString(), range.to.toISOString()],
  ) as Array<{ opened_at: string | Date; wallet: string; source_ref: string | null; notional_usd: string | number | null }>;
  const firstRows = await sql.unsafe(
    `SELECT DISTINCT ON (wallet) wallet, opened_at AS first_at, source_ref
     FROM sofinance_position_opens
     ORDER BY wallet, opened_at ASC`,
  ) as Array<{ wallet: string; first_at: string | Date; source_ref: string | null }>;
  const firstByWallet = new Map(firstRows.map((row) => {
    const opened = row.first_at instanceof Date ? row.first_at : new Date(row.first_at);
    return [row.wallet, { day: utcDay(opened), at: opened.getTime(), ref: row.source_ref }] as const;
  }));
  return {
    configured: true,
    days: aggregateOpensDaily(recordsFromOpenRows(rows), firstByWallet),
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
  };
}

export { opensDailyCsv };
