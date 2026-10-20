const URL_RE = /https?:\/\/[^\s"'\\]+/gi;
const SECRET_ASSIGN_RE =
  /(?:api[_-]?key|authorization|bearer|token|secret|x-api-key|sig)\s*[:=]\s*\S+/gi;
const SIGNATURE_RE = /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SECRET_KEY_RE =
  /(?:^|[_-])(?:api[_-]?key|authorization|cookie|secret|token|password|bearer)(?:$|[_-])/i;
const NAMED_SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-cron-secret|x-forwarded-for|x-real-ip|forwarded)$/i;

export function isSensitiveHeaderName(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("x-vercel-") || NAMED_SENSITIVE_HEADER_RE.test(key) || SECRET_KEY_RE.test(key);
}

export function scrubSensitiveText(text: string): string {
  return text
    .replace(URL_RE, "[redacted-url]")
    .replace(SECRET_ASSIGN_RE, "[redacted-secret]")
    .replace(SIGNATURE_RE, "[redacted-signature]")
    .replace(ADDRESS_RE, "[redacted-address]");
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    next[key] = isSensitiveHeaderName(key) ? "[redacted]" : scrubSensitiveText(value);
  }
  return next;
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubSensitiveText(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen));
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    next[key] = isSensitiveHeaderName(key) ? "[redacted]" : scrubValue(nested, seen);
  }
  return next;
}

export type ScrubableSentryEvent = {
  message?: string;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  user?: { ip_address?: string } | unknown;
  exception?: { values?: Array<{ value?: string; type?: string }> };
  breadcrumbs?: { values?: Array<{ message?: string; data?: Record<string, unknown> }> };
  request?: {
    url?: string;
    headers?: Record<string, string> | string;
    query_string?: string | Record<string, string> | Array<[string, string]>;
    cookies?: unknown;
    data?: unknown;
    env?: Record<string, string>;
  };
};

function dropUserIp(event: ScrubableSentryEvent) {
  delete event.user;
}

/** Drop request bodies / auth / IPs / Vercel bypass and redact wallets, signatures, RPC URLs, and keys. */
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
    if (typeof target.request.headers === "string") {
      target.request.headers = scrubSensitiveText(target.request.headers);
    } else if (target.request.headers) {
      target.request.headers = scrubHeaders(target.request.headers);
    }
    if (typeof target.request.query_string === "string") {
      target.request.query_string = scrubSensitiveText(target.request.query_string);
    } else if (target.request.query_string) {
      target.request.query_string = scrubValue(target.request.query_string, new WeakSet()) as
        typeof target.request.query_string;
    }
    if (target.request.env) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(target.request.env)) {
        env[key] = isSensitiveHeaderName(key) || /ip|forwarded|remote_addr/i.test(key)
          ? "[redacted]"
          : scrubSensitiveText(value);
      }
      target.request.env = env;
    }
    delete target.request.cookies;
    delete target.request.data;
  }
  dropUserIp(target);
  return event;
}
