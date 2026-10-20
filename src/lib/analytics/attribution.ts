export const FIRST_TOUCH_KEY = "sofinance:growth:first-touch:v1";

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

export type Attribution = {
  ref?: string;
} & Partial<Record<UtmKey, string>>;

const ATTR_VALUE = /^[\w.:-]+$/;

export function sanitizeAttrValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !ATTR_VALUE.test(trimmed)) return undefined;
  return trimmed;
}

export function isEmptyAttribution(value: Attribution): boolean {
  if (value.ref) return false;
  return UTM_KEYS.every((key) => !value[key]);
}

export function parseAttribution(search: string): Attribution {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const attribution: Attribution = {};
  const ref = sanitizeAttrValue(params.get("ref"));
  if (ref) attribution.ref = ref;
  for (const key of UTM_KEYS) {
    const value = sanitizeAttrValue(params.get(key));
    if (value) attribution[key] = value;
  }
  return attribution;
}

export function sanitizeAttribution(record: Record<string, unknown>): Attribution {
  const attribution: Attribution = {};
  const ref = sanitizeAttrValue(record.ref);
  if (ref) attribution.ref = ref;
  for (const key of UTM_KEYS) {
    const value = sanitizeAttrValue(record[key]);
    if (value) attribution[key] = value;
  }
  return attribution;
}

/** First non-empty attribution wins (first attributed touch). */
export function resolveFirstTouch(existing: Attribution | null, incoming: Attribution): Attribution {
  if (existing && !isEmptyAttribution(existing)) return existing;
  return incoming;
}

export function loadStoredAttribution(storage: Pick<Storage, "getItem">): Attribution | null {
  try {
    const raw = storage.getItem(FIRST_TOUCH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const attribution = sanitizeAttribution(parsed as Record<string, unknown>);
    return isEmptyAttribution(attribution) ? null : attribution;
  } catch {
    return null;
  }
}

export function readAndStoreFirstTouch(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): Attribution {
  const first = resolveFirstTouch(loadStoredAttribution(storage), parseAttribution(search));
  if (!isEmptyAttribution(first)) storage.setItem(FIRST_TOUCH_KEY, JSON.stringify(first));
  return first;
}

export function getStoredAttribution(
  storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): Attribution | null {
  if (!storage) return null;
  return loadStoredAttribution(storage);
}
