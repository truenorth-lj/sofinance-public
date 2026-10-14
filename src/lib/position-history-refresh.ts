/** Browser dirty markers carry cache bypass across server instances and page remounts. */
export const POSITION_HISTORY_REFRESH_STORAGE_KEY = "sofinance:position-history-refresh:v1";
export const POSITION_HISTORY_REFRESH_EVENT = "sofinance:position-history-refresh";
const MAX_POSITIONS = 64;
const MAX_SIGNATURES = 8;
const pubkey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const signaturePattern = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export type PositionHistoryRefresh = { signatures: string[]; version: string };
type Entry = PositionHistoryRefresh & { positionMint: string };
let fallback: Entry[] = [];
let persistencePending = false;

function parseEntries(value: string | null): Entry[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Entry => item && typeof item.positionMint === "string" &&
      pubkey.test(item.positionMint) && typeof item.version === "string" && item.version.length <= 100 &&
      Array.isArray(item.signatures) && item.signatures.length <= MAX_SIGNATURES &&
      item.signatures.every((signature: unknown) => typeof signature === "string" && signaturePattern.test(signature)))
      .slice(-MAX_POSITIONS);
  } catch { return []; }
}

function readEntries(): Entry[] {
  if (typeof window === "undefined") return [];
  if (persistencePending) {
    // Quota failures can leave storage readable but stale. Keep our newer state
    // authoritative until the entire marker set can be persisted successfully.
    try {
      window.localStorage.setItem(POSITION_HISTORY_REFRESH_STORAGE_KEY, JSON.stringify(fallback));
      persistencePending = false;
    } catch { /* Preserve pending markers and their compare-and-clear versions. */ }
    return fallback;
  }
  try { return parseEntries(window.localStorage.getItem(POSITION_HISTORY_REFRESH_STORAGE_KEY)); }
  catch { return fallback; }
}

function saveEntries(entries: Entry[]) {
  fallback = entries.slice(-MAX_POSITIONS);
  try {
    window.localStorage.setItem(POSITION_HISTORY_REFRESH_STORAGE_KEY, JSON.stringify(fallback));
    persistencePending = false;
  } catch {
    persistencePending = true;
    /* Private browsing or quota may block writes; same-tab invalidation still works. */
  }
}

export function readPositionHistoryRefresh(positionMint: string): PositionHistoryRefresh | null {
  const entry = readEntries().find(item => item.positionMint === positionMint);
  return entry ? { signatures: [...entry.signatures], version: entry.version } : null;
}

export function notifyPositionHistoryChange(positionMint: string, signature?: string): void {
  if (typeof window === "undefined" || !pubkey.test(positionMint) || (signature && !signaturePattern.test(signature))) return;
  const entries = readEntries();
  const previous = entries.find(item => item.positionMint === positionMint);
  if (signature && previous?.signatures.includes(signature)) return;
  if (!signature && previous && !previous.signatures.length) return;
  const signatures = signature ? [...(previous?.signatures ?? []), signature].slice(-MAX_SIGNATURES)
    : previous?.signatures ?? [];
  const version = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  saveEntries([...entries.filter(item => item.positionMint !== positionMint), { positionMint, signatures, version }]);
  window.dispatchEvent(new CustomEvent(POSITION_HISTORY_REFRESH_EVENT, { detail: { positionMint } }));
}

/** An older request must never acknowledge a newer transaction. */
export function clearPositionHistoryRefresh(positionMint: string, version: string): boolean {
  if (typeof window === "undefined") return false;
  const entries = readEntries();
  if (entries.find(item => item.positionMint === positionMint)?.version !== version) return false;
  saveEntries(entries.filter(item => item.positionMint !== positionMint));
  return true;
}

export function subscribePositionHistoryRefresh(positionMint: string, listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onChange = (event: Event) => {
    if ((event as CustomEvent<{ positionMint?: string }>).detail?.positionMint === positionMint) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== POSITION_HISTORY_REFRESH_STORAGE_KEY) return;
    const before = parseEntries(event.oldValue).find(item => item.positionMint === positionMint);
    const after = parseEntries(event.newValue).find(item => item.positionMint === positionMint);
    if (after && after.version !== before?.version) listener();
  };
  window.addEventListener(POSITION_HISTORY_REFRESH_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(POSITION_HISTORY_REFRESH_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
