const URL_RE = /https?:\/\/[^\s"'\\]+/gi;
const SECRET_ASSIGN_RE =
  /(?:api[_-]?key|authorization|bearer|token|secret|x-api-key)\s*[:=]\s*\S+/gi;
const SIGNATURE_RE = /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SECRET_KEY_RE =
  /(?:^|[_-])(?:api[_-]?key|authorization|cookie|secret|token|password|bearer)(?:$|[_-])/i;
const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|x-api-key|x-cron-secret|proxy-authorization)$/i;

export function scrubSensitiveText(text: string): string {
  return text
    .replace(URL_RE, "[redacted-url]")
    .replace(SECRET_ASSIGN_RE, "[redacted-secret]")
    .replace(SIGNATURE_RE, "[redacted-signature]")
    .replace(ADDRESS_RE, "[redacted-address]");
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubSensitiveText(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen));
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    next[key] = SECRET_KEY_RE.test(key) || SENSITIVE_HEADER_RE.test(key)
      ? "[redacted]"
      : scrubValue(nested, seen);
  }
  return next;
}

export type ScrubableSentryEvent = {
  message?: string;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: unknown;
  exception?: { values?: Array<{ value?: string; type?: string }> };
  breadcrumbs?: { values?: Array<{ message?: string; data?: Record<string, unknown> }> };
  request?: {
    url?: string;
    headers?: Record<string, string>;
    query_string?: string | Record<string, string> | Array<[string, string]>;
    cookies?: unknown;
    data?: unknown;
  };
};

/** Drop request bodies / auth and redact wallets, signatures, RPC URLs, and keys. */
export function scrubSentryEvent<T>(event: T): T {
  const target = event as T & ScrubableSentryEvent;
  if (target.message) target.message = scrubSensitiveText(target.message);
  if (target.exception?.values) {
    for (const value of target.exception.values) {
      if (value.value) value.value = scrubSensitiveText(value.value);
    }
  }
  if (target.tags) {
    for (const [key, value] of Object.entries(target.tags)) {
      if (key === "route" || key === "error_class") continue;
      if (typeof value === "string") target.tags[key] = scrubSensitiveText(value);
    }
  }
  if (target.extra) target.extra = scrubValue(target.extra, new WeakSet()) as Record<string, unknown>;
  if (target.contexts) target.contexts = scrubValue(target.contexts, new WeakSet()) as Record<string, unknown>;
  if (target.breadcrumbs?.values) {
    for (const crumb of target.breadcrumbs.values) {
      if (crumb.message) crumb.message = scrubSensitiveText(crumb.message);
      if (crumb.data) crumb.data = scrubValue(crumb.data, new WeakSet()) as Record<string, unknown>;
    }
  }
  if (target.request) {
    if (target.request.url) target.request.url = scrubSensitiveText(target.request.url);
    if (target.request.headers) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(target.request.headers)) {
        headers[key] = SENSITIVE_HEADER_RE.test(key) || SECRET_KEY_RE.test(key)
          ? "[redacted]"
          : scrubSensitiveText(value);
      }
      target.request.headers = headers;
    }
    if (typeof target.request.query_string === "string") {
      target.request.query_string = scrubSensitiveText(target.request.query_string);
    } else if (target.request.query_string) {
      target.request.query_string = scrubValue(target.request.query_string, new WeakSet()) as
        typeof target.request.query_string;
    }
    delete target.request.cookies;
    delete target.request.data;
  }
  delete target.user;
  return event;
}
