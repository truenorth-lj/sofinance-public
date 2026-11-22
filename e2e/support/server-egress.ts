import { existsSync, readFileSync } from "node:fs";

/** Written by scripts/hermetic-egress-guard.mjs inside the hermetic server: one JSON line per refused non-local request. */
export const SERVER_EGRESS_LEDGER = new URL("../.server-egress-blocked.jsonl", import.meta.url);

export type BlockedEgress = { at: string; host: string; path: string; via?: string };

export function readBlockedEgress(ledger: URL | string = SERVER_EGRESS_LEDGER): BlockedEgress[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as BlockedEgress);
}

export const describeBlockedEgress = (entries: readonly BlockedEgress[]) =>
  entries.map((entry) => `server-side ${entry.via ?? "request"} to ${entry.host}${entry.path} blocked`);
