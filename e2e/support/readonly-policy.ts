import { randomUUID } from "node:crypto";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { readonlyTransportFor } from "./readonly-transport";

const PUBLIC_PAGES = new Set([
  "/", "/app", "/app/plan", "/app/rwa-pairs", "/app/position-performance",
  "/app/ai", "/docs", "/docs/fee-apr", "/blog",
  "/app/sign/AAAA.BBBB", "/app/sign/justonepart",
]);
const PUBLIC_READS = new Set([
  "/api/rwa-pairs", "/api/sol-usdc-price", "/api/pool-range-apr", "/api/pool-daily-apr",
]);
type Scope = "external" | "telemetry" | "wallet-stub" | "public-read" | "forbidden";
type Event = { action: "blocked" | "forwarded" | "stubbed" | "response" | "cancelled"; scope: Scope | "websocket" | "redirect"; host: string; method: string; resource: string };
type Observation = { ordinal: number; scope: Scope; host: string; method: string; resource: string; observedDuring: "running" | "closing" };

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
 * Production MUST supply a deny-proxy context via readonly-fixture or createReadonlyContext.
 * Raw contexts retain route-only compatibility for legacy controls, with no containment claim.
 * Use the returned close() before the final audit so pending callbacks have settled.
 * Public reads may cause server-side provider activity; this is a browser boundary, not a server sandbox.
 */
export async function installReadonlyPolicy(context: BrowserContext, baseURL: string, address?: string) {
  const origin = new URL(baseURL).origin;
  if (!/^https?:\/\//.test(origin) || context.pages().length || context.serviceWorkers().length) {
    throw new Error("Readonly policy requires an HTTP(S) origin and a fresh context");
  }
  const transport = readonlyTransportFor(context);
  const events: Event[] = [];
  const violations: string[] = [];
  const unhandled = new Set<Request>();
  const observations = new Map<Request, Observation>();
  const pending = new Set<Promise<void>>();
  const ownedPages = new Set<Page>();
  let owningContextClose = false;
  let closed = false;
  const closeReason = `Readonly policy shutdown ${randomUUID()}`;
  let cancelling = false;
  let closing: Promise<void> | undefined;
  const isOwnedCancellation = (error: unknown) =>
    cancelling && error instanceof Error && error.message.includes(closeReason);
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  };
  const record = (request: Request, action: Event["action"], scope: Event["scope"]) => {
    // Never retain paths, queries, headers, bodies, wallet addresses or project IDs.
    events.push({ action, scope, host: new URL(request.url()).hostname, method: request.method(), resource: request.resourceType() });
  };
  context.on("page", page => {
    page.on("crash", () => violations.push("Readonly page crashed"));
    page.on("close", () => {
      if (!ownedPages.has(page) && !owningContextClose) violations.push("Readonly page closed outside policy ownership");
    });
  });
  context.on("close", () => {
    if (!owningContextClose) violations.push("Readonly context closed outside policy ownership");
  });
  const observeTerminal = (request: Request) => {
    if (unhandled.has(request) && !cancelling) violations.push("Restricted request completed without readonly handler during active run");
  };
  context.on("requestfinished", observeTerminal);
  context.on("requestfailed", observeTerminal);
  context.on("request", request => {
    const scope = scopeOf(request, origin);
    if (["external", "forbidden", "telemetry"].includes(scope)) {
      unhandled.add(request);
      observations.set(request, {
        ordinal: observations.size + 1, scope, host: new URL(request.url()).hostname,
        method: request.method(), resource: request.resourceType(), observedDuring: cancelling ? "closing" : "running",
      });
    }
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

  // Own both readonly stub fulfill callbacks, rather than losing downstream
  // completion tracking through fallback. Ordinary hermetic stubs are unchanged.
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
      const wallet = new URL(request.url()).searchParams.get("wallet") ?? address ?? "";
      await route.fulfill({ status: 200, contentType: "application/json",
        headers: { "content-security-policy": "worker-src 'none'" },
        body: request.method() === "GET"
          ? JSON.stringify({ wallet, slot: 1, fetchedAt: Date.now(), positions: [], assets: [] }) : "{}",
      });
    } else if (cancelling) {
      await route.abort("blockedbyclient");
      record(request, "cancelled", scope);
    } else {
      // continue() can follow redirects without re-running this handler. Fetch exactly one hop,
      // then refuse ALL redirects (including same-origin); smoke tests require canonical URLs.
      record(request, "forwarded", scope);
      const response = transport ? await transport.fetch(request) : await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      let deliveryCancelled = false;
      const responseErrors: unknown[] = [];
      try {
        if (response.status() >= 300 && response.status() < 400) {
          record(request, "blocked", "redirect");
          violations.push("Redirect refused by readonly policy");
          await route.abort("blockedbyclient");
        } else if (cancelling) {
          // The allowed transport may already have reached the server. We own shutdown
          // and no longer need to deliver its response to a closing document. Do not
          // call fulfill on the dead route, or turn a generic fulfill error into success.
          deliveryCancelled = true;
        } else {
          // Playwright WebSocket routing does not cover worker sockets. This lane needs no
          // workers: prevent dedicated/shared worker creation, including blob workers, by CSP.
          const headers = response.headers();
          headers["content-security-policy"] = [headers["content-security-policy"], "worker-src 'none'"].filter(Boolean).join(", ");
          await route.fulfill({ response, headers });
        }
      } catch (error) { responseErrors.push(error); }
      try { await response.dispose(); }
      catch (error) { responseErrors.push(error); }
      if (responseErrors.length) {
        // A cleanup rejection must not replace a delivery/processing failure. Classify
        // both, preferring any non-owned failure over cancellation; all-owned errors
        // still produce exactly one cancellation. The index also preserves throw undefined.
        const unexpected = responseErrors.findIndex(error => !isOwnedCancellation(error));
        throw responseErrors[unexpected === -1 ? 0 : unexpected];
      }
      if (deliveryCancelled) record(request, "cancelled", scope);
    }
  })().catch(async error => {
    // Only our explicit context-close reason identifies an intentional cancellation.
    // Generic disposed/timeout/socket errors remain failures, including during shutdown.
    if (isOwnedCancellation(error)) {
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
      cancelling = true;
      transport?.ownClose(closeReason);
      try {
        const pages = await Promise.allSettled(context.pages().map(async page => {
          ownedPages.add(page);
          try { await page.close({ reason: closeReason }); }
          catch (error) { violations.push("Readonly page close failed"); throw error; }
        }));
        const failed = pages.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        owningContextClose = true;
        try { await context.close({ reason: closeReason }); }
        catch (error) { violations.push("Readonly context close failed"); throw error; }
        finally {
          try { await transport?.close(); }
          finally { while (pending.size) await Promise.all([...pending]); }
        }
      }
      closed = true;
    })(),
    transportAudit: () => transport?.audit() ?? { guarantee: "route-only" as const },
    // Preserve per-request UNKNOWN even with the independent proxy guarantee. Route-only
    // callers still fail unknowns after close. No requestfailed/sink inference is used.
    unhandledRequests: () => [...unhandled].map(request => ({
      ...observations.get(request)!, outcome: "unknown" as const,
      ...(transport ? { containment: "deny-only-browser-proxy" as const } : {}),
    })),
    failures: () => [
      ...violations, ...(transport?.audit().failures ?? []),
      ...[...unhandled].flatMap(request => {
        // Containment is independent of requestfailed, SDK delivery, sink counts or
        // close timing. Keep the observation UNKNOWN; do not forge an abort event.
        // An attempted forbidden operation still fails, even if no handler ran.
        if (transport && closed) return scopeOf(request, origin) === "forbidden"
          ? ["Operation outside readonly browser scope was attempted"] : [];
        return ["Forbidden request was not intercepted; transport outcome unknown"];
      }),
    ],
  };
}
