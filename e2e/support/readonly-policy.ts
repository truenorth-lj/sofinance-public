import type { BrowserContext, Request } from "@playwright/test";
import { stubWalletApis } from "./guards";

const PUBLIC_PAGES = new Set([
  "/", "/app", "/app/plan", "/app/rwa-pairs", "/app/position-performance",
  "/app/ai", "/docs", "/docs/yield-and-apr", "/blog",
  "/app/sign/AAAA.BBBB", "/app/sign/justonepart",
]);
const PUBLIC_READS = new Set([
  "/api/rwa-pairs", "/api/sol-usdc-price", "/api/pool-range-apr", "/api/pool-daily-apr",
]);
type Scope = "external" | "telemetry" | "wallet-stub" | "public-read" | "forbidden";
type Event = { action: "blocked" | "forwarded" | "stubbed" | "response"; scope: Scope | "websocket" | "redirect"; host: string; method: string; resource: string };

function scopeOf(request: Request, origin: string): Scope {
  const url = new URL(request.url());
  if (url.origin !== origin) return "external";
  if (url.pathname === "/lumen" || url.pathname.startsWith("/lumen/")) return "telemetry";
  const method = request.method();
  if ((method === "GET" && url.pathname === "/api/wallet" && url.searchParams.has("wallet")) ||
      (method === "POST" && url.pathname === "/api/token-metadata" && !url.search)) return "wallet-stub";
  if (method === "GET" && (PUBLIC_PAGES.has(url.pathname) || PUBLIC_READS.has(url.pathname) ||
      url.pathname.startsWith("/_next/static/") || url.pathname === "/favicon.ico")) return "public-read";
  if (method === "POST" && url.pathname === "/api/verify-sign-token") {
    try {
      const body = request.postDataJSON();
      if (body && Object.keys(body).length === 1 && ["AAAA.BBBB", "justonepart"].includes(body.token)) return "public-read";
    } catch { /* malformed input is not a smoke-lane operation */ }
  }
  return "forbidden";
}

/** Install on a fresh serviceWorkers:block context, before pages, and AFTER any local fixture routes.
 * Do not add page routes or overriding context routes afterwards. APIRequestContext is outside this policy.
 * Public reads may cause server-side provider activity; this is a browser boundary, not a server sandbox.
 */
export async function installReadonlyPolicy(context: BrowserContext, baseURL: string, address?: string) {
  const origin = new URL(baseURL).origin;
  if (!/^https?:\/\//.test(origin) || context.pages().length || context.serviceWorkers().length) {
    throw new Error("Readonly policy requires an HTTP(S) origin and a fresh context");
  }
  const events: Event[] = [];
  const violations: string[] = [];
  const unhandled = new Set<Request>();
  const record = (request: Request, action: Event["action"], scope: Event["scope"]) => {
    // Never retain paths, queries, headers, bodies, wallet addresses or project IDs.
    events.push({ action, scope, host: new URL(request.url()).hostname, method: request.method(), resource: request.resourceType() });
  };
  context.on("request", request => {
    if (["external", "forbidden", "telemetry"].includes(scopeOf(request, origin))) unhandled.add(request);
  });
  context.on("response", response => {
    const request = response.request();
    const scope = scopeOf(request, origin);
    if (["external", "forbidden", "telemetry"].includes(scope)) {
      record(request, "response", scope);
      violations.push("Forbidden browser response observed (routing bypass)");
    }
  });
  context.on("serviceworker", () => violations.push("Service worker created: serviceWorkers:block is required"));

  await stubWalletApis(context, address);
  // Last registered context route runs first. Only the two explicit wallet stubs fall through.
  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    const scope = scopeOf(request, origin);
    unhandled.delete(request);
    if (scope === "external" || scope === "telemetry" || scope === "forbidden") {
      record(request, "blocked", scope);
      if (scope === "forbidden") violations.push("Operation outside readonly browser scope was attempted");
      await route.abort("blockedbyclient");
    } else if (scope === "wallet-stub") {
      record(request, "stubbed", scope);
      await route.fallback();
    } else {
      // continue() can follow redirects without re-running this handler. Fetch exactly one hop,
      // then refuse ALL redirects (including same-origin); smoke tests require canonical URLs.
      record(request, "forwarded", scope);
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      try {
        if (response.status() >= 300 && response.status() < 400) {
          record(request, "blocked", "redirect");
          violations.push("Redirect refused by readonly policy");
          await route.abort("blockedbyclient");
        } else {
          // Playwright WebSocket routing does not cover worker sockets. This lane needs no
          // workers: prevent dedicated/shared worker creation, including blob workers, by CSP.
          const headers = response.headers();
          headers["content-security-policy"] = [headers["content-security-policy"], "worker-src 'none'"].filter(Boolean).join(", ");
          await route.fulfill({ response, headers });
        }
      } finally { await response.dispose(); }
    }
  });
  await context.routeWebSocket(/.*/, async socket => {
    events.push({ action: "blocked", scope: "websocket", host: new URL(socket.url()).hostname, method: "CONNECT", resource: "websocket" });
    // No connectToServer: not even a handshake reaches the peer.
    await socket.close();
  });
  return {
    events,
    failures: () => [...violations, ...[...unhandled].map(() => "Forbidden request was not intercepted; transport outcome unknown")],
  };
}
