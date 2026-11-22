// Preloaded into the hermetic `next start` only (serve-app.mjs passes `--import`); the app and production never load it.
// Any server-side fetch, undici request, http(s).request or WebSocket to a non-local host is refused before it leaves
// the process: the call rejects with a clear error, the server logs it, and it is appended to a ledger that the
// hermetic tests check (support/server-egress.ts). Only localhost / 127.0.0.1 / ::1 (and unix sockets) are allowed.
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";

// E2E_EGRESS_LEDGER exists only so the policy test can exercise this module in isolation (never the shared ledger).
const ledger = process.env.E2E_EGRESS_LEDGER ?? fileURLToPath(new URL("../.server-egress-blocked.jsonl", import.meta.url));
writeFileSync(`${ledger}.loaded`, String(process.pid));

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);

const normalizeHost = (hostname) =>
  String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");

const isAllowedHost = (hostname) => {
  const host = normalizeHost(hostname);
  return !host || LOCAL_HOSTS.has(host);
};

/** Path without query/hash; redact segments that look like API keys (RPC keys often live in the path, not the query). */
const safePath = (path) => {
  const raw = String(path ?? "/").split("?")[0].split("#")[0] || "/";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.split("/").map((segment) => (
    segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment) ? "…" : segment
  )).join("/") || "/";
};

const record = (via, host, path) => {
  appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), host: normalizeHost(host), path: safePath(path), via })}\n`);
};

const blockError = (via, host, path) =>
  new Error(`[e2e hermetic] blocked server-side ${via} to ${normalizeHost(host)}${safePath(path)}. Mock this route in the test.`);

const check = (via, host, path) => {
  if (isAllowedHost(host)) return null;
  record(via, host, path);
  const error = blockError(via, host, path);
  console.error(error.message);
  return error;
};

const urlOf = (input) => {
  try { return new URL(input instanceof Request ? input.url : String(input)); }
  catch { return null; }
};

const realFetch = globalThis.fetch;
globalThis.fetch = function hermeticFetch(input, init) {
  const url = urlOf(input);
  const error = url ? check("fetch", url.hostname, url.pathname) : null;
  if (error) return Promise.reject(error);
  return realFetch.call(this, input, init);
};

// undici.request / Client / Pool. Node's fetch also uses a dispatcher, but the fetch hook above rejects first, so
// those are recorded only as "fetch". This hook covers callers that go to undici directly.
try {
  const undici = await import("undici");
  if (typeof undici.setGlobalDispatcher === "function" && typeof undici.Agent === "function") {
    const inner = new undici.Agent();
    const originalDispatch = inner.dispatch.bind(inner);
    inner.dispatch = function hermeticDispatch(opts, handler) {
      let host = "";
      let path = "/";
      try {
        const origin = new URL(typeof opts.origin === "string" || opts.origin instanceof URL ? opts.origin : String(opts.origin ?? ""));
        host = origin.hostname;
        path = opts.path != null ? String(opts.path) : origin.pathname;
      } catch { /* empty host is treated as local */ }
      const error = check("undici", host, path);
      if (error) {
        if (handler && typeof handler.onError === "function") handler.onError(error);
        return false;
      }
      return originalDispatch(opts, handler);
    };
    undici.setGlobalDispatcher(inner);
  }
} catch { /* undici may be absent in odd runtimes */ }

const destinationFromArgs = (args) => {
  const first = args[0];
  const second = typeof args[1] === "object" && args[1] ? args[1] : null;
  if (typeof first === "string" || first instanceof URL) {
    try {
      const url = new URL(first);
      return { host: url.hostname, path: second?.path ?? second?.pathname ?? url.pathname };
    } catch { /* fall through */ }
  }
  const options = first && typeof first === "object" && !(first instanceof URL) ? first : second;
  if (!options || options.socketPath) return null;
  const host = options.hostname ?? (typeof options.host === "string" ? options.host.split(":")[0] : "");
  return { host, path: options.path ?? options.pathname ?? "/" };
};

// Shared dummy so a blocked https.request does not go through the https stack.
const rawHttpRequest = http.request.bind(http);

const blockedRequest = (error) => {
  const request = rawHttpRequest({
    protocol: "http:",
    hostname: "127.0.0.1",
    port: 9,
    path: "/",
    method: "GET",
    createConnection(_options, callback) {
      const socket = new net.Socket();
      process.nextTick(() => {
        if (typeof callback === "function") callback(error);
        else socket.destroy(error);
      });
      return socket;
    },
  });
  process.nextTick(() => {
    if (!request.destroyed && !request.errored) {
      request.emit("error", error);
      request.destroy(error);
    }
  });
  return request;
};

const wrapOutgoing = (mod, via) => {
  const rawRequest = mod.request.bind(mod);
  mod.request = function hermeticOutgoing(...args) {
    const dest = destinationFromArgs(args);
    const error = dest ? check(via, dest.host, dest.path) : null;
    if (error) return blockedRequest(error);
    return rawRequest(...args);
  };
  // Node's http.get calls request then end; re-implement it so we do not double-wrap.
  mod.get = function hermeticGet(...args) {
    const request = mod.request(...args);
    request.end();
    return request;
  };
};

wrapOutgoing(http, "http.request");
wrapOutgoing(https, "https.request");

const RealWebSocket = globalThis.WebSocket;
if (typeof RealWebSocket === "function") {
  globalThis.WebSocket = class HermeticWebSocket extends RealWebSocket {
    constructor(url, protocols) {
      let parsed = null;
      try { parsed = new URL(String(url)); } catch { /* leave parsed null */ }
      const error = parsed ? check("WebSocket", parsed.hostname, parsed.pathname) : null;
      if (error) throw error;
      super(url, protocols);
    }
  };
}
