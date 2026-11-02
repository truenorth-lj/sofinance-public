/**
 * A multi-step run (e.g. a multi-step withdraw or an open's setup → deposit) that stopped half-way because the panel
 * went away (unmount, tab switch, wallet switch) after some steps were already sent to Solana. Before PR10 that
 * stop was silent; now it leaves a marker so the partly finished operation stays visible:
 *   - one `console.warn("[tx-interrupted]", …)` line, and
 *   - a small localStorage record per flow + scope, read by the panel for that scope on its next mount.
 * The record is cleared when a later run of the same flow + scope sends its last step, or when the user dismisses it.
 */
export type TxInterruption = { flow: string; scope: string; step: number; of?: number; signatures: string[]; at: number };

const PREFIX = "sofinance:tx-interrupted:";
const keyFor = (flow: string, scope: string) => `${PREFIX}${flow}:${scope}`;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = (): StorageLike | undefined => { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } };

export function recordTxInterruption(entry: Omit<TxInterruption, "at">, storage: StorageLike | undefined = browserStorage()): TxInterruption {
  const record = { ...entry, at: Date.now() };
  // eslint-disable-next-line no-console -- deliberate marker: a partly finished multi-step operation (PM, PR10)
  console.warn("[tx-interrupted]", JSON.stringify(record));
  try { storage?.setItem(keyFor(entry.flow, entry.scope), JSON.stringify(record)); } catch { /* the console line still marks it */ }
  return record;
}

export function readTxInterruption(flow: string, scope: string, storage: StorageLike | undefined = browserStorage()): TxInterruption | null {
  try {
    const raw = storage?.getItem(keyFor(flow, scope));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TxInterruption>;
    if (value.flow !== flow || value.scope !== scope || !Number.isSafeInteger(value.step) || !Array.isArray(value.signatures)
      || !value.signatures.every((item) => typeof item === "string" && SIGNATURE.test(item))) return null;
    return value as TxInterruption;
  } catch { return null; }
}

export function clearTxInterruption(flow: string, scope: string, storage: StorageLike | undefined = browserStorage()) {
  try { storage?.removeItem(keyFor(flow, scope)); } catch { /* nothing to clear */ }
}

/** "This operation stopped after step 1 of 2 …": plain words for the marker. */
export function txInterruptionMessage(entry: Pick<TxInterruption, "step" | "of" | "signatures">): string {
  const done = entry.signatures.length;
  const total = entry.of ? ` of ${entry.of}` : "";
  return `An earlier run stopped part-way: ${done === 1 ? "step 1" : `steps 1–${done}`}${total} ${done === 1 ? "was" : "were"} sent to Solana, but step ${entry.step}${total} was never sent. Check the steps on Solscan and the position, then run it again to finish.`;
}
