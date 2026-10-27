import { randomUUID } from "node:crypto";
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
type Event = { action: "blocked" | "forwarded" | "stubbed" | "response" | "cancelled"; scope: Scope | "websocket" | "redirect"; host: string; method: string; resource: string };

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
 * Use the returned close() before the final audit so pending callbacks have settled.
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
  const pending = new Set<Promise<void>>();
  const closeReason = `Readonly policy shutdown ${randomUUID()}`;
  let cancelling = false;
  let closing: Promise<void> | undefined;
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  };
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

  // A JSON stub can also be navigated to as a same-origin document. Its realm needs
  // the same worker restriction as fetched HTML; JSON MIME alone is not isolation.
  await stubWalletApis(context, address, { "content-security-policy": "worker-src 'none'" });
  // Last registered context route runs first. Only the two explicit wallet stubs fall through.
  await context.route(/^https?:\/\//, route => track((async () => {
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
  })().catch(async error => {
    // Only our explicit context-close reason identifies an intentional cancellation.
    // Generic disposed/timeout/socket errors remain failures, including during shutdown.
    if (cancelling && error instanceof Error && error.message.includes(closeReason)) {
      record(route.request(), "cancelled", scopeOf(route.request(), origin));
    } else {
      violations.push("Readonly route failed unexpectedly");
      try { await route.abort("failed"); } catch { violations.push("Failed route could not be aborted"); }
    }
  })));
  await context.routeWebSocket(/.*/, socket => track((async () => {
    events.push({ action: "blocked", scope: "websocket", host: new URL(socket.url()).hostname, method: "CONNECT", resource: "websocket" });
    // No connectToServer: not even a handshake reaches the peer.
    await socket.close();
  })().catch(() => { violations.push("Readonly WebSocket close failed unexpectedly"); })));
  return {
    events,
    close: () => closing ??= (async () => {
      // Stop document scripts with guards still installed, then cancel held fetches.
      // BrowserContext.close disposes its request client before finishing route callbacks.
      try {
        await Promise.all(context.pages().map(page => page.close()));
      } finally {
        cancelling = true;
        await context.close({ reason: closeReason });
        while (pending.size) await Promise.all([...pending]);
      }
    })(),
    failures: () => [...violations, ...[...unhandled].map(() => "Forbidden request was not intercepted; transport outcome unknown")],
  };
}
