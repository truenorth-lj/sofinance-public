import type { DailyOpens, DailyRefOpens, OpenLogRecord } from "./types";

function addNotional(current: number | null, next: number | null) {
  if (next === null) return current;
  return (current ?? 0) + next;
}

function emptyRef(): DailyRefOpens {
  return { ref: null, opens: 0, uniqueWallets: 0, newUniqueWallets: 0, notionalUsd: null };
}

type Bucket = {
  opens: number;
  wallets: Set<string>;
  newWallets: Set<string>;
  notionalUsd: number | null;
  byRef: Map<string, { opens: number; wallets: Set<string>; newWallets: Set<string>; notionalUsd: number | null }>;
};

function refKey(ref: string | null) {
  return ref ?? "";
}

export function firstOpenDayByWallet(records: OpenLogRecord[]) {
  const first = new Map<string, { day: string; at: number; ref: string | null }>();
  for (const record of records) {
    const seen = first.get(record.wallet);
    if (!seen || record.openedAtMs < seen.at) {
      first.set(record.wallet, { day: record.day, at: record.openedAtMs, ref: record.ref });
    }
  }
  return first;
}

export function aggregateOpensDaily(
  records: OpenLogRecord[],
  first = firstOpenDayByWallet(records),
): DailyOpens[] {
  const days = new Map<string, Bucket>();
  for (const record of records) {
    let bucket = days.get(record.day);
    if (!bucket) {
      bucket = { opens: 0, wallets: new Set(), newWallets: new Set(), notionalUsd: null, byRef: new Map() };
      days.set(record.day, bucket);
    }
    bucket.opens += 1;
    bucket.wallets.add(record.wallet);
    bucket.notionalUsd = addNotional(bucket.notionalUsd, record.notionalUsd);
    const firstOpen = first.get(record.wallet);
    const isNew = firstOpen?.day === record.day;
    if (isNew) bucket.newWallets.add(record.wallet);

    const key = refKey(record.ref);
    let refBucket = bucket.byRef.get(key);
    if (!refBucket) {
      refBucket = { opens: 0, wallets: new Set(), newWallets: new Set(), notionalUsd: null };
      bucket.byRef.set(key, refBucket);
    }
    refBucket.opens += 1;
    refBucket.wallets.add(record.wallet);
    refBucket.notionalUsd = addNotional(refBucket.notionalUsd, record.notionalUsd);
    if (isNew && firstOpen?.ref === record.ref) refBucket.newWallets.add(record.wallet);
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      date,
      opens: bucket.opens,
      uniqueWallets: bucket.wallets.size,
      newUniqueWallets: bucket.newWallets.size,
      notionalUsd: bucket.notionalUsd,
      byRef: [...bucket.byRef.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, refBucket]) => ({
          ...emptyRef(),
          ref: key || null,
          opens: refBucket.opens,
          uniqueWallets: refBucket.wallets.size,
          newUniqueWallets: refBucket.newWallets.size,
          notionalUsd: refBucket.notionalUsd,
        })),
    }));
}

export function opensDailyCsv(days: DailyOpens[]) {
  const header = "type,date,ref,opens,unique_wallets,new_unique_wallets,notional_usd";
  const lines = [header];
  const usd = (value: number | null) => (value === null ? "" : String(value));
  const refCell = (value: string | null) => (value ?? "");
  for (const day of days) {
    lines.push(["day", day.date, "", String(day.opens), String(day.uniqueWallets), String(day.newUniqueWallets), usd(day.notionalUsd)].join(","));
    for (const row of day.byRef) {
      lines.push(["ref", day.date, refCell(row.ref), String(row.opens), String(row.uniqueWallets), String(row.newUniqueWallets), usd(row.notionalUsd)].join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}
