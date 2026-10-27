const URL_RE = /https?:\/\/[^\s"'\\]+/gi;
const ENCODED_URL_RE = /https?%3A%2F%2F[^\s"'\\&]*/gi;
// Also consume non-key JSON strings as tokens: assignments/schemes inside them
// must wait for string decoding, or escaped whitespace can split credentials.
const DIAGNOSTIC_TOKEN_RE = /(?<![\w%\\-])(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([\w%\\-]+))\s*[:=]\s*|(?<![\w-])(?:Basic|Bearer)\s+|"(?:\\[\s\S]|[^"\\])*"/gi;
const JSON_STRING_RE = /"(?:\\[\s\S]|[^"\\])*"/g;
const MAX_TEXT_LENGTH = 65_536;
const MAX_JSON_STRING_DEPTH = 4;
const MAX_VALUE_DEPTH = 32;
const REDACTED = "[redacted-secret]";
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

type KeyPolicy =
  | { status: "safe" | "sensitive"; key: string }
  | { status: "invalid" | "unsupported" };
type KeyContext = "object" | "header" | "ip" | "text";

/** Classify while the key still owns its value. Rendering a placeholder is not
 * evidence that the associated subtree is safe. Percent decoding is bounded;
 * raw backslash escapes are unsupported (JSON tokens decode them before here).
 */
export function classifyDiagnosticKey(name: string, context: KeyContext = "object"): KeyPolicy {
  if (name.length > MAX_TEXT_LENGTH) return { status: "unsupported" };
  let key = name;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(key); round += 1) {
    try {
      key = key.replace(/(?:%[0-9a-f]{2})+/gi, (run) => decodeURIComponent(run));
    } catch {
      return { status: "invalid" };
    }
  }
  if (/%[0-9a-f]{2}/i.test(key) || key.includes("\\")) return { status: "unsupported" };
  if (key.includes("%")) return { status: "invalid" };
  // Keys with diagnostic syntax cannot be safely treated as one label. Do not
  // let later text rendering turn such a key into a label without its value.
  if (/[\s"'=:{},\[\]\u0000-\u001f\u007f]/.test(key)) return { status: "unsupported" };
  const header = key.toLowerCase().startsWith("x-vercel-") || NAMED_SENSITIVE_HEADER_RE.test(key) || SECRET_KEY_RE.test(key);
  const ip = IP_ENV_SEGMENT_RE.test(key);
  const sensitive = context === "ip" ? ip : header ||
    (context === "object" && ip) || (context === "text" && key.toLowerCase() === "sig");
  return { status: sensitive ? "sensitive" : "safe", key };
}

export function isSensitiveHeaderName(name: unknown): boolean {
  return typeof name === "string" && classifyDiagnosticKey(name, "header").status !== "safe";
}

export function isSensitiveIpEnvKey(name: unknown): boolean {
  return typeof name === "string" && classifyDiagnosticKey(name, "ip").status !== "safe";
}

export function isSensitiveObjectKey(name: unknown): boolean {
  return typeof name === "string" && classifyDiagnosticKey(name).status !== "safe";
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
    // Remove entire sensitive values before decoding their strings. Otherwise
    // an inner decode/replacement can destroy the enclosing value's boundary.
    const scrubbed = applyTextScrubbers(scrubJsonStrings(applyTextScrubbers(current), depth));
    let invalidEncoding = false;
    const next = scrubbed.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try { return decodeURIComponent(encoded); } catch { invalidEncoding = true; return ""; }
    });
    if (invalidEncoding) return REDACTED;
    // '+' is a valid credential character, not form-data whitespace here.
    if (next === scrubbed) return scrubbed;
    current = next;
  }
  const final = applyTextScrubbers(scrubJsonStrings(applyTextScrubbers(current), depth));
  // A bounded decoder must not return still-encoded labels or values as safe.
  // Ordinary percent prose (e.g. 50%) has no byte escape and remains readable.
  return /%[0-9a-f]{2}/i.test(final) ? REDACTED : final;
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

/** End of a quoted scalar or balanced collection, including diagnostic objects
 * with unquoted keys. This is a boundary scanner, never an evaluator. It does
 * not descend into live objects or invoke getters/toJSON. Unknown/mismatched
 * boundaries return null so the caller drops the diagnostic instead of a prefix.
 */
function credentialValueEnd(text: string, start: number): number | null {
  const scheme = /^(?:Basic|Bearer)\s+/i.exec(text.slice(start));
  if (scheme) start += scheme[0].length;
  const first = text[start];
  if (!first) return null;
  const stack: string[] = [];
  let quote = first === '"' || first === "'" ? first : "";
  if (first === "[" || first === "{") stack.push(first === "[" ? "]" : "}");
  if (!quote && !stack.length) {
    const scalar = /^[^\s"',;}&\]\\]+/.exec(text.slice(start));
    if (!scalar) return null;
    const end = start + scalar[0].length;
    return text[end] === "\\" ? null : end;
  }
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") { i += 1; continue; }
      if (char !== quote) continue;
      quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      if (stack.length >= MAX_VALUE_DEPTH) return null;
      stack.push(char === "[" ? "]" : "}");
    } else if (char === "]" || char === "}") {
      if (stack.pop() !== char) return null;
    }
    if (!quote && stack.length === 0) {
      const next = text[i + 1];
      return !next || /[\s,;}&\])]/.test(next) ? i + 1 : null;
    }
  }
  return null;
}

function scrubAssignments(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(DIAGNOSTIC_TOKEN_RE)) {
    if (match.index < cursor) continue;
    let key = match[1] ?? match[2] ?? match[3];
    if (match[1]?.includes("\\")) {
      try { key = JSON.parse(`"${match[1]}"`); } catch { return REDACTED; }
    }
    const policy = key !== undefined ? classifyDiagnosticKey(key, "text") : undefined;
    if (policy?.status === "invalid" || policy?.status === "unsupported") return REDACTED;
    if (policy ? policy.status === "safe" : !/^(?:Basic|Bearer)\s/i.test(match[0])) continue;
    const start = match.index + match[0].length;
    const end = credentialValueEnd(text, start);
    if (end === null) return REDACTED;
    // Keep valid JSON valid; plain assignments retain their existing wording.
    const replacement = match[1] !== undefined || match[2] !== undefined
      ? `${match[0]}"${REDACTED}"` : REDACTED;
    result += text.slice(cursor, match.index) + replacement;
    cursor = end;
  }
  return result + text.slice(cursor);
}

function applyTextScrubbers(text: string): string {
  // Scan values before URL replacement can eat a closing bracket/brace.
  return scrubAssignments(text).replace(URL_RE, "[redacted-url]")
    .replace(ENCODED_URL_RE, "[redacted-url]");
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

const MAX_OBJECT_DEPTH = 8;
const MAX_OBJECT_ENTRIES = 50;

/** Copy only descriptor values, never live hooks or accessors. Key policy runs
 * before value access, including headers; sensitive subtrees are never visited.
 */
function scrubStructured(value: unknown, seen: WeakSet<object>, depth: number, headers = false, reservedKey?: string): unknown {
  if (typeof value === "string") return scrubSensitiveText(value);
  if (typeof value === "function" || typeof value === "symbol") return "[redacted]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted]";
  if (depth >= MAX_OBJECT_DEPTH) return "[truncated]";
  seen.add(value);
  try {
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return undefined;
      return "value" in descriptor ? scrubStructured(descriptor.value, seen, depth + 1) : "[unavailable]";
    };
    if (Array.isArray(value)) {
      const items = Array.from({ length: Math.min(value.length, MAX_OBJECT_ENTRIES) }, (_, i) => read(String(i)));
      if (value.length > MAX_OBJECT_ENTRIES) items.push("[truncated]");
      return items;
    }
    const next: Record<string, unknown> = Object.create(null);
    const ownKeys = Object.keys(value);
    // Reserve within selection, not object insertion order: integer-index keys
    // enumerate first even if a route was inserted before them. Nested objects
    // retain the ordinary budget; only the top-level tags reserve a route slot.
    const keys = reservedKey && ownKeys.includes(reservedKey)
      ? [reservedKey, ...ownKeys.filter((key) => key !== reservedKey)] : ownKeys;
    for (const key of keys.slice(0, MAX_OBJECT_ENTRIES)) {
      const policy = classifyDiagnosticKey(key);
      const displayKey = "key" in policy ? scrubSensitiveText(policy.key) : REDACTED;
      if (policy.status === "safe") {
        next[displayKey] = read(key);
      } else {
        next[displayKey] = "[redacted]";
        // Preserve the existing header-array shape without reading its elements
        // or calling a user-supplied map/getter. Never traverse a hidden value.
        if (headers && policy.status === "sensitive") {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && "value" in descriptor && Array.isArray(descriptor.value)) {
            next[displayKey] = Array.from({ length: Math.min(descriptor.value.length, MAX_OBJECT_ENTRIES) }, () => "[redacted]");
          }
        }
      }
    }
    if (keys.length > MAX_OBJECT_ENTRIES) next.truncated = true;
    return next;
  } catch {
    return "[unavailable]";
  }
}

export function scrubUnknown<T>(value: T, seen = new WeakSet<object>()): T {
  return scrubStructured(value, seen, 0) as T;
}

function scrubHeaders(headers: unknown): unknown {
  return scrubStructured(headers, new WeakSet<object>(), 0, true);
}

export type ScrubableSentryEvent = {
  message?: unknown;
  transaction?: unknown;
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
  const transaction = asString(target.transaction);
  if (transaction !== undefined) target.transaction = scrubSensitiveText(transaction);
  if (Array.isArray(target.exception?.values)) {
    for (const value of target.exception.values) {
      if (!value || typeof value !== "object") continue;
      const text = asString(value.value);
      if (text !== undefined) value.value = scrubSensitiveText(text);
    }
  }
  if (target.tags !== undefined) {
    target.tags = scrubStructured(target.tags, new WeakSet<object>(), 0, false, "route") as ScrubableSentryEvent["tags"];
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

/** Fallbacks can receive raw tags when preparation fails before the tag copy.
 * Only keep an own route data value; never invoke a route accessor or retain
 * unsanitized text. The fixed "route" key needs no dynamic key classification.
 */
export function scrubRouteTag(tags: Record<string, unknown> | undefined): string | undefined {
  const descriptor = tags && Object.getOwnPropertyDescriptor(tags, "route");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? scrubSensitiveText(descriptor.value) : undefined;
}

/** Last-resort event if beforeSend throws: keep exception + route, strip request PII. */
export function minimalSentryEvent<T>(event: T): T {
  const next = event as T & ScrubableSentryEvent;
  next.user = undefined;
  next.extra = undefined;
  next.contexts = undefined;
  next.breadcrumbs = undefined;
  try {
    const message = asString(next.message);
    next.message = message !== undefined ? scrubSensitiveText(message) : undefined;
  } catch {
    next.message = undefined;
  }
  try {
    const transaction = asString(next.transaction);
    next.transaction = transaction !== undefined ? scrubSensitiveText(transaction) : undefined;
  } catch {
    next.transaction = undefined;
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
    const route = scrubRouteTag(next.tags);
    next.tags = route ? { route } : {};
  } catch {
    next.tags = {};
  }
  try {
    const req = next.request && isPlainObject(next.request) ? next.request : undefined;
    const method = asString(req?.method);
    const url = asString(req?.url);
    next.request = url || method
      ? { url: url ? scrubSensitiveText(url.split("?")[0]) : undefined, method }
      : undefined;
  } catch {
    next.request = undefined;
  }
  return next;
}
