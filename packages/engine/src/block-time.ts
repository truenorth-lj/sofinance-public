import type { Connection } from "@solana/web3.js";

const LOOKBACK_SLOTS = 16;

async function blockTimeAt(connection: Connection, slot: number) {
  if (!Number.isSafeInteger(slot) || slot < 0) return null;
  try {
    const time = await connection.getBlockTime(slot);
    return typeof time === "number" ? time : null;
  } catch {
    // Confirmed tip slots are often skipped or not yet available.
    return null;
  }
}

/** Prefer the given/confirmed slot; if that block is missing, walk back nearby slots. */
export async function readRecentBlockTime(connection: Connection, slot?: number): Promise<number | null> {
  const tip = slot ?? await connection.getSlot("confirmed");
  const newest = await blockTimeAt(connection, tip);
  if (newest !== null) return newest;
  const older = await Promise.all(
    Array.from({ length: LOOKBACK_SLOTS }, (_, index) => blockTimeAt(connection, tip - index - 1)),
  );
  return older.find((time): time is number => time !== null) ?? null;
}
