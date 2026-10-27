const URL_RE = /https?:\/\/[^\s"'\\]+/gi;
const ENCODED_URL_RE = /https?%3A%2F%2F[^\s"'\\&]*/gi;
// Consume a complete quoted value (including escaped quotes), or one unquoted
// value up to a diagnostic/query delimiter.
const SECRET_VALUE = String.raw`(?:"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[^\s"',;}&]+)`;
const KEY_ASSIGN_RE = /(?<![\w-])([\w-]+)["']?\s*[:=]\s*/g;
const CREDENTIAL_VALUE_RE = new RegExp(String.raw`^(?:(?:Basic|Bearer)[ \t]+)?${SECRET_VALUE}`, "i");
const AUTH_VALUE_RE = new RegExp(
  String.raw`(?<![\w-])(?:Basic|Bearer)[ \t]+${SECRET_VALUE}`, "gi",
);
const JSON_STRING_RE = /"(?:\\[\s\S]|[^"\\])*"/g;
const MAX_TEXT_LENGTH = 65_536;
const MAX_JSON_STRING_DEPTH = 4;
const SIGNATURE_RE = /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;
const ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SECRET_KEY_RE =
  /(?:^|[_-])(?:api[_-]?key|authorization|cookie|secret|token|password|bearer)(?:$|[_-])/i;
const NAMED_SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-cron-secret|x-forwarded-for|x-real-ip|forwarded)$/i;
/** Whole segments only — must not match "description" or "zip". */
const IP_ENV_SEGMENT_RE = /(?:^|[_\-])(?:ip|forwarded|remote[_-]?addr)(?:$|[_\-])/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSensitiveHeaderName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const key = name.toLowerCase();
  return key.startsWith("x-vercel-") || NAMED_SENSITIVE_HEADER_RE.test(key) || SECRET_KEY_RE.test(key);
}

export function isSensitiveIpEnvKey(name: unknown): boolean {
  return typeof name === "string" && IP_ENV_SEGMENT_RE.test(name);
}

export function isSensitiveObjectKey(name: unknown): boolean {
  return isSensitiveHeaderName(name) || isSensitiveIpEnvKey(name);
}

/** Strip credentials and provider URLs while preserving public account identifiers. */
export function scrubCredentialText(text: string): string {
  return scrubCredentialLayer(text, 0);
}

function scrubCredentialLayer(text: string, depth: number): string {
  if (text.length > MAX_TEXT_LENGTH || depth > MAX_JSON_STRING_DEPTH) return "[redacted-secret]";
  let current = text;
  for (let i = 0; i < 3; i += 1) {
    // Scrub before decoding so encoded whitespace inside a URL/value cannot
    // split off its tail. A stray '%' in prose must not block other escapes.
    const scrubbed = applyTextScrubbers(scrubJsonStrings(current, depth));
    const next = scrubbed.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    });
    // '+' is a valid credential character, not form-data whitespace here.
    if (next === scrubbed) return scrubbed;
    current = next;
  }
  return applyTextScrubbers(scrubJsonStrings(current, depth));
}

/** Decode only complete JSON string tokens, including strings embedded in prose.
 * Never expose JSON.parse errors (which can contain the original credential).
 * Unterminated escaped fragments and excessive nesting fail closed.
 */
function scrubJsonStrings(text: string, depth: number): string {
  let cursor = 0;
  let unsafe = false;
  const result = text.replace(JSON_STRING_RE, (token: string, offset: number) => {
    const prefix = text.slice(cursor, offset);
    if (/\\"|\\$/.test(prefix)) unsafe = true;
    cursor = offset + token.length;
    // Decode percent escapes inside the string boundary as well, so decoding
    // quotes cannot turn a valid outer JSON string into an unsafe fragment.
    if (!token.includes("\\") && !/%[0-9a-f]{2}/i.test(token)) return token;
    try {
      const decoded: string = JSON.parse(token);
      return JSON.stringify(scrubCredentialLayer(decoded, depth + 1));
    } catch {
      return '"[redacted-secret]"';
    }
  });
  if (/\\"/.test(text.slice(cursor))) unsafe = true;
  return unsafe ? "[redacted-secret]" : result;
}

function scrubAssignments(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(KEY_ASSIGN_RE)) {
    if (match.index < cursor) continue;
    const key = match[1];
    // Use the same complete-key segment policy as structured headers. `sig` is
    // the existing text-only shorthand; ordinary design/mytoken stay readable.
    if (!key || (!isSensitiveHeaderName(key) && key.toLowerCase() !== "sig")) continue;
    const start = match.index + match[0].length;
    const value = CREDENTIAL_VALUE_RE.exec(text.slice(start));
    if (!value) continue;
    result += text.slice(cursor, match.index) + "[redacted-secret]";
    cursor = start + value[0].length;
  }
  return result + text.slice(cursor);
}

function applyTextScrubbers(text: string): string {
  return scrubAssignments(text
    .replace(URL_RE, "[redacted-url]")
    .replace(ENCODED_URL_RE, "[redacted-url]"))
    .replace(AUTH_VALUE_RE, "[redacted-secret]");
}

/** Strings only. Arrays/objects recurse; every other type is returned unchanged. */
export function scrubSensitiveText<T>(text: T): T {
  if (typeof text === "string") {
    return scrubCredentialText(text).replace(SIGNATURE_RE, "[redacted-signature]")
      .replace(ADDRESS_RE, "[redacted-address]") as T;
  }
  if (text !== null && typeof text === "object") {
    return scrubUnknown(text);
  }
  return text;
}

export function scrubUnknown<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return scrubSensitiveText(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted]" as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubUnknown(item, seen)) as T;
  if (!isPlainObject(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = isSensitiveObjectKey(key) ? "[redacted]" : scrubUnknown(nested, seen);
  }
  return next as T;
}

function scrubHeaderValue(key: string, value: unknown): unknown {
  if (isSensitiveHeaderName(key)) {
    return Array.isArray(value) ? value.map(() => "[redacted]") : "[redacted]";
  }
  return scrubUnknown(value);
}

function scrubHeaders(headers: unknown): unknown {
  if (typeof headers === "string") return scrubSensitiveText(headers);
  if (Array.isArray(headers)) return scrubUnknown(headers);
  if (!isPlainObject(headers)) return headers;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    next[key] = scrubHeaderValue(key, value);
  }
  return next;
}

export type ScrubableSentryEvent = {
  message?: unknown;
  extra?: unknown;
  contexts?: unknown;
  tags?: Record<string, unknown>;
  user?: unknown;
  exception?: { values?: Array<{ value?: unknown; type?: unknown }> };
  breadcrumbs?: unknown;
  request?: {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
    env?: unknown;
  };
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Scrub breadcrumb message + data (including data.url / url.query). */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  const crumb = breadcrumb as T & { message?: unknown; data?: unknown };
  if (typeof crumb.message === "string") crumb.message = scrubSensitiveText(crumb.message);
  if (crumb.data !== undefined) crumb.data = scrubUnknown(crumb.data);
  return breadcrumb;
}

function scrubBreadcrumbs(breadcrumbs: unknown): unknown {
  if (Array.isArray(breadcrumbs)) return breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  if (isPlainObject(breadcrumbs) && Array.isArray(breadcrumbs.values)) {
    breadcrumbs.values = breadcrumbs.values.map((crumb) => scrubBreadcrumb(crumb));
    return breadcrumbs;
  }
  return breadcrumbs;
}

/** Drop request bodies / auth / IPs / Vercel bypass and redact wallets, signatures, RPC URLs, and keys. */
export function scrubSentryEvent<T>(event: T): T {
  const target = event as T & ScrubableSentryEvent;
  const message = asString(target.message);
  if (message !== undefined) target.message = scrubSensitiveText(message) as string;
  if (Array.isArray(target.exception?.values)) {
    for (const value of target.exception.values) {
      if (!value || typeof value !== "object") continue;
      const text = asString(value.value);
      if (text !== undefined) value.value = scrubSensitiveText(text);
    }
  }
  if (isPlainObject(target.tags)) {
    for (const [key, value] of Object.entries(target.tags)) {
      if (key === "route" || key === "error_class") continue;
      if (typeof value === "string") target.tags[key] = scrubSensitiveText(value);
    }
  }
  if (target.extra !== undefined) target.extra = scrubUnknown(target.extra) as ScrubableSentryEvent["extra"];
  if (target.contexts !== undefined) target.contexts = scrubUnknown(target.contexts) as ScrubableSentryEvent["contexts"];
  if (target.breadcrumbs !== undefined) target.breadcrumbs = scrubBreadcrumbs(target.breadcrumbs);
  if (isPlainObject(target.request)) {
    if (typeof target.request.url === "string") {
      target.request.url = scrubSensitiveText(target.request.url) as string;
    }
    if (target.request.headers !== undefined) target.request.headers = scrubHeaders(target.request.headers);
    if (target.request.query_string !== undefined) {
      target.request.query_string = scrubUnknown(target.request.query_string);
    }
    if (target.request.env !== undefined) target.request.env = scrubUnknown(target.request.env);
    delete target.request.cookies;
    delete target.request.data;
  }
  delete target.user;
  return event;
}

/** Last-resort event if beforeSend throws: keep exception + route, strip request PII. */
export function minimalSentryEvent<T>(event: T): T {
  const next = event as T & ScrubableSentryEvent;
  next.user = undefined;
  next.extra = undefined;
  next.breadcrumbs = undefined;
  try {
    const message = asString(next.message);
    next.message = message !== undefined ? scrubSensitiveText(message) : undefined;
  } catch {
    next.message = undefined;
  }
  try {
    const values = next.exception?.values;
    next.exception = Array.isArray(values)
      ? {
          values: values
            .filter((value): value is { value?: unknown; type?: unknown } => Boolean(value) && typeof value === "object")
            .map((value) => ({
              type: asString(value.type),
              value: typeof value.value === "string" ? scrubSensitiveText(value.value) : undefined,
            })),
        }
      : undefined;
  } catch {
    next.exception = undefined;
  }
  try {
    const route = typeof next.tags?.route === "string" ? next.tags.route : undefined;
    next.tags = route ? { route } : {};
  } catch {
    next.tags = {};
  }
  try {
    const req = next.request && isPlainObject(next.request) ? next.request : undefined;
    const method = asString(req?.method);
    const url = asString(req?.url);
    next.request = url || method
      ? { url: url ? url.split("?")[0] : undefined, method }
      : undefined;
  } catch {
    next.request = undefined;
  }
  return next;
}
