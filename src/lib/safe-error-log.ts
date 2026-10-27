// These scrubbers are pure and do not import or initialize the Sentry SDK.
import { classifyDiagnosticKey, scrubSensitiveText } from "./sentry/scrub";

type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };
const MAX_DEPTH = 8;
const MAX_ENTRIES = 50;

/** Copy diagnostics, never passing live errors or custom inspection hooks to console. */
function snapshot(value: unknown, seen = new WeakSet<object>(), depth = 0): LogValue {
  try {
    if (typeof value === "string") return scrubSensitiveText(value);
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value !== "object") return "[redacted]";
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[truncated]";
    seen.add(value);

    const read = (key: string, errorField = false): LogValue => {
      try {
        // V8 may expose Error.stack as a lazy accessor. Only known Error
        // fields may invoke getters; arbitrary diagnostic properties may not.
        if (errorField) return snapshot(Reflect.get(value, key), seen, depth + 1);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return undefined;
        return "value" in descriptor ? snapshot(descriptor.value, seen, depth + 1) : "[unavailable]";
      } catch {
        return "[unavailable]";
      }
    };
    if (Array.isArray(value)) {
      const items = Array.from({ length: Math.min(value.length, MAX_ENTRIES) }, (_, index) => read(String(index)));
      if (value.length > MAX_ENTRIES) items.push("[truncated]");
      return items;
    }

    const result: { [key: string]: LogValue } = Object.create(null);
    if (value instanceof Error) {
      // name is usually inherited; message, stack, cause and AggregateError.errors
      // are usually non-enumerable, so Object.keys alone loses the diagnostics.
      for (const key of ["name", "message", "stack", "cause", "errors"]) result[key] = read(key, true);
    }
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_ENTRIES)) {
      if (Object.hasOwn(result, key)) continue;
      const policy = classifyDiagnosticKey(key);
      const displayKey = "key" in policy ? scrubSensitiveText(policy.key) : "[redacted-secret]";
      result[displayKey] = policy.status === "safe" ? read(key) : "[redacted]";
    }
    if (keys.length > MAX_ENTRIES) result.truncated = true;
    return result;
  } catch {
    // A revoked proxy or malformed error must not replace the original failure.
    return "[unavailable]";
  }
}

export function logSafeError(message: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(scrubSensitiveText(message), snapshot(error));
}
