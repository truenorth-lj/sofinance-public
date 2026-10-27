import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { installReadonlyPolicy } from "../../support/readonly-policy";
import { createReadonlyContext, readonlyTransportFor } from "../../support/readonly-transport";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function serve(handler?: RequestListener, tls?: { key: Buffer; cert: Buffer }) {
  const hits: string[] = [], upgrades: string[] = [];
  const listener: RequestListener = (req, res) => {
    hits.push(req.url!);
    if (handler) handler(req, res);
    else { res.setHeader("access-control-allow-origin", "*"); res.end("<title>healthy</title>"); }
  };
  const server = tls ? createTlsServer(tls, listener) : createServer(listener);
  server.on("upgrade", (req, socket) => { upgrades.push(req.url!); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  return { hits, upgrades, origin: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

for (const mode of ["fetch", "keepalive", "beacon"] as const) {
  for (const scope of ["external", "telemetry", "forbidden"] as const) {
    test(`proxy contains skipped ${scope} ${mode} without claiming per-request abort`, async ({ browser }, info) => {
      const app = await serve(), sink = await serve();
      const context = await createReadonlyContext(browser);
      const policy = await installReadonlyPolicy(context, app.origin);
      try {
        const page = await context.newPage(); await page.goto(app.origin);
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        const target = scope === "external" ? sink.origin + "/synthetic" : app.origin + (scope === "telemetry" ? "/lumen/synthetic" : "/api/selected-prepare");
        const started = deferred(); let closing: Promise<void> | undefined;
        context.on("request", request => { if (request.url() === target) { closing = policy.close(); started.resolve(); } });
        await page.evaluate(({ target, mode }) => {
          if (mode === "beacon") navigator.sendBeacon(target, "synthetic");
          else void fetch(target, { keepalive: mode === "keepalive" }).catch(() => {});
        }, { target, mode }).catch(() => {});
        await started.promise; await closing;
        expect(policy.unhandledRequests()).toEqual([{
          ordinal: 1, scope, host: "127.0.0.1", method: mode === "beacon" ? "POST" : "GET",
          resource: mode === "beacon" ? "ping" : "fetch", observedDuring: "running", outcome: "unknown", containment: "deny-only-browser-proxy",
        }]);
        expect(policy.events.filter(e => e.action === "blocked")).toEqual([]);
        expect(policy.failures()).toEqual(scope === "forbidden" ? ["Operation outside readonly browser scope was attempted"] : []);
        expect(app.hits).toEqual(["/"]); expect(sink.hits).toEqual([]);
        await info.attach("contained-unknown", { body: JSON.stringify({ events: policy.events, unhandled: policy.unhandledRequests(), failures: policy.failures(), transport: policy.transportAudit(), hits: app.hits, sinkHits: sink.hits }), contentType: "application/json" });
      } finally { await policy.close(); await Promise.all([app.close(), sink.close()]); }
    });
  }
}

test("deny-only proxy independently covers HTTP HTTPS WS WSS; disabled proxy reaches every sink", async ({ browser }, info) => {
  const owned = mkdtempSync(join(tmpdir(), "readonly-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(owned, "key.pem"), "-out", join(owned, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = { key: readFileSync(join(owned, "key.pem")), cert: readFileSync(join(owned, "cert.pem")) };
  const app = await serve(), secure = await serve(undefined, tls);
  try {
    for (const proxy of [true, false]) {
      // No policy routes at all: this tests the independent transport, not abort().
      const context = proxy ? await createReadonlyContext(browser, { ignoreHTTPSErrors: true }) : await browser.newContext({ ignoreHTTPSErrors: true });
      try {
        const page = await context.newPage();
        const http = await page.goto(app.origin + "/http");
        expect(http?.status()).toBe(proxy ? 502 : 200);
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        const afterHttp = readonlyTransportFor(context)?.audit();
        await page.evaluate(url => new Promise<void>(resolve => {
          const ws = new WebSocket(url.replace("http:", "ws:") + "/ws"); ws.onerror = () => resolve();
        }), app.origin);
        const afterWs = readonlyTransportFor(context)?.audit();
        const tlsPage = await context.newPage();
        const https = await tlsPage.goto(secure.origin + "/https").catch(() => null);
        if (proxy) expect(https).toBeNull(); else expect(https?.status()).toBe(200);
        const afterHttps = readonlyTransportFor(context)?.audit();
        // Return to HTTP to give WSS a live script realm even when CONNECT was denied.
        await page.goto(app.origin + "/realm");
        await page.evaluate(url => new Promise<void>(resolve => {
          const ws = new WebSocket(url.replace("https:", "wss:") + "/wss"); ws.onerror = () => resolve();
        }), secure.origin);
        expect(app.hits).toEqual(proxy ? [] : ["/http", "/realm"]);
        expect(secure.hits).toEqual(proxy ? [] : ["/https"]);
        expect(app.upgrades).toEqual(proxy ? [] : ["/ws"]);
        expect(secure.upgrades).toEqual(proxy ? [] : ["/wss"]);
        const audit = readonlyTransportFor(context)?.audit();
        if (audit) {
          expect(audit.denied.http).toBeGreaterThanOrEqual(2);
          expect(audit.denied.connect).toBeGreaterThanOrEqual(2);
          // Pinned Chromium uses CONNECT even for ws:// through an HTTP proxy.
          expect(afterWs!.denied.connect).toBeGreaterThan(afterHttp!.denied.connect);
          expect(afterHttps!.denied.connect).toBeGreaterThan(afterWs!.denied.connect);
          expect(audit.denied.connect).toBeGreaterThan(afterHttps!.denied.connect);
          expect(audit.failures).toEqual([]);
        }
        await info.attach(`proxy-${proxy}`, { body: JSON.stringify({ audit, afterHttp, afterWs, afterHttps, http: app.hits, https: secure.hits, ws: app.upgrades, wss: secure.upgrades }), contentType: "application/json" });
      } finally { await context.close(); await readonlyTransportFor(context)?.close(); }
    }
    // Allowed HTTPS goes through the independent client, not CONNECT. Certificate
    // validation follows the explicit context option; production retains false.
    for (const ignoreHTTPSErrors of [true, false]) {
      const context = await createReadonlyContext(browser, { ignoreHTTPSErrors });
      const policy = await installReadonlyPolicy(context, secure.origin);
      try {
        const page = await context.newPage();
        if (ignoreHTTPSErrors) {
          expect((await page.goto(secure.origin))?.status()).toBe(200);
          await expect(page).toHaveTitle("healthy");
          expect(await page.evaluate(() => navigator.onLine)).toBe(true);
        } else await expect(page.goto(secure.origin)).rejects.toThrow();
        await policy.close();
        if (ignoreHTTPSErrors) expect(policy.failures()).toEqual([]);
        else expect(policy.failures()).toContain("Readonly route failed unexpectedly");
        expect(readonlyTransportFor(context)!.audit().denied.connect).toBe(0);
      } finally { await policy.close(); }
    }
  } finally { await Promise.all([app.close(), secure.close()]); rmSync(owned, { recursive: true }); }
});

test("readable online pages preserve headers cookies and allowed POST; API client stays independent", async ({ browser, request }) => {
  const seen: { path: string; cookie: string; body: string; marker: string }[] = [];
  const app = await serve((req, res) => {
    let body = ""; req.on("data", data => { body += data; });
    req.on("end", () => {
      seen.push({ path: req.url!, cookie: req.headers.cookie ?? "", body, marker: String(req.headers["x-synthetic"] ?? "") });
      if (req.url === "/") { res.setHeader("content-type", "text/html"); res.setHeader("Set-Cookie", "synthetic=one; Path=/; HttpOnly"); res.end("<nav>readable</nav>"); }
      else { if (req.url === "/api/rwa-pairs") res.setHeader("Set-Cookie", "synthetic=deleted; Path=/; Max-Age=0"); res.setHeader("content-type", "application/json"); res.end('{"healthy":true}'); }
    });
  });
  const context = await createReadonlyContext(browser), policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin); await expect(page.locator("nav")).toHaveText("readable");
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    expect(await page.evaluate(() => fetch("/api/rwa-pairs", { headers: { "x-synthetic": "marker" } }).then(r => r.json()))).toEqual({ healthy: true });
    expect(await page.evaluate(() => fetch("/api/sol-usdc-price").then(r => r.json()))).toEqual({ healthy: true });
    await page.evaluate(() => fetch("/api/verify-sign-token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "AAAA.BBBB" }) }).then(r => r.text()));
    expect(seen).toEqual([
      { path: "/", cookie: "", body: "", marker: "" },
      { path: "/api/rwa-pairs", cookie: "synthetic=one", body: "", marker: "marker" },
      { path: "/api/sol-usdc-price", cookie: "", body: "", marker: "" },
      { path: "/api/verify-sign-token", cookie: "", body: '{"token":"AAAA.BBBB"}', marker: "" },
    ]);
    // Associated browser API client inherits its deny proxy. A standalone API fixture
    // deliberately does not; production restricts it to the two fixed MCP actions.
    const denied = await context.request.get(app.origin + "/direct"); expect(denied.status()).toBe(502);
    const direct = await request.get(app.origin + "/direct", { maxRedirects: 0, maxRetries: 0 }); expect(direct.status()).toBe(200);
    expect(seen.filter(s => s.path === "/direct")).toHaveLength(1);
    await policy.close(); expect(policy.failures()).toEqual([]);
  } finally { await policy.close(); await app.close(); }
});

test("two pages with held allowed responses close once; a second owner remains online and healthy", async ({ browser }) => {
  const held = new Map<string, ServerResponse>();
  const app = await serve((req, res) => { if (req.url!.startsWith("/api/rwa-pairs")) held.set(req.url!, res); else res.end("<title>healthy</title>"); });
  const contexts = await Promise.all([createReadonlyContext(browser), createReadonlyContext(browser)]);
  const policies = await Promise.all(contexts.map(c => installReadonlyPolicy(c, app.origin)));
  try {
    const first = contexts[0]!, second = contexts[1]!, owner = policies[0]!, other = policies[1]!;
    const pages = await Promise.all([first.newPage(), first.newPage(), second.newPage()]);
    await Promise.all(pages.map(p => p.goto(app.origin)));
    await Promise.all(pages.map((p, i) => p.evaluate(i => { Object.assign(window, { result: fetch("/api/rwa-pairs?i=" + i).then(r => r.json()).catch(() => "cancelled") }); }, i)));
    await expect.poll(() => held.size).toBe(3);
    const closing = owner.close(); expect(owner.close()).toBe(closing); await closing;
    expect(owner.events.filter(e => e.action === "cancelled")).toHaveLength(2); expect(owner.failures()).toEqual([]);
    expect(await pages[2]!.evaluate(() => navigator.onLine)).toBe(true);
    held.get("/api/rwa-pairs?i=2")!.end('{"healthy":true}');
    expect(await pages[2]!.evaluate(() => (window as unknown as { result: Promise<unknown> }).result)).toEqual({ healthy: true });
    await other.close(); expect(other.failures()).toEqual([]);
    expect(other.events.filter(e => e.action === "cancelled")).toEqual([]);
  } finally { await Promise.all(policies.map(p => p.close())); await app.close(); }
});

test("active bypass and forbidden attempts remain failures after contained teardown", async ({ browser }) => {
  const app = await serve(), sink = await serve();
  const context = await createReadonlyContext(browser), policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    await page.evaluate(() => fetch("/api/selected-prepare").catch(() => {}));
    await page.route(sink.origin + "/bypass", route => route.continue());
    const terminal = context.waitForEvent("requestfinished", { predicate: r => r.url() === sink.origin + "/bypass" });
    await page.goto(sink.origin + "/bypass"); await terminal;
    const before = policy.failures();
    expect(before).toContain("Operation outside readonly browser scope was attempted");
    expect(before).toContain("Restricted request completed without readonly handler during active run");
    expect(before).toContain("Forbidden browser response observed (routing bypass)");
    await policy.close();
    for (const failure of before.filter(f => !f.includes("outcome unknown"))) expect(policy.failures()).toContain(failure);
    expect(sink.hits).toEqual([]);
    expect(policy.unhandledRequests()[0]?.outcome).toBe("unknown");
  } finally { await policy.close(); await Promise.all([app.close(), sink.close()]); }
});

for (const mode of ["success", "redirect", "generic-fetch", "foreign-fetch", "own-fetch", "generic-fulfill", "generic-dispose", "own-dispose"] as const) {
  test(`managed forwarding drains and preserves ${mode} across close`, async ({ browser }, info) => {
    const sink = await serve();
    const app = await serve((req, res) => {
      if (req.url === "/api/rwa-pairs" && mode === "redirect") res.writeHead(302, { location: sink.origin + "/escape" });
      res.end("<title>healthy</title>");
    });
    const context = await createReadonlyContext(browser), transport = readonlyTransportFor(context)!;
    const entered = deferred(), release = deferred(); let reason = "", fulfillCalls = 0;
    const disposeClient = transport.client.dispose.bind(transport.client);
    transport.client.dispose = async options => { reason = options?.reason ?? ""; return disposeClient(options); };
    const fetch = transport.client.fetch.bind(transport.client);
    transport.client.fetch = async (url, options) => {
      if (typeof url === "string" || new URL(url.url()).pathname !== "/api/rwa-pairs") return fetch(url, options);
      if (mode.endsWith("fetch")) {
        entered.resolve(); await release.promise;
        throw new Error(mode === "own-fetch" ? reason : mode === "foreign-fetch" ? "Readonly policy shutdown foreign-owner" : "Target page, context or browser has been closed");
      }
      const response = await fetch(url, options);
      const dispose = response.dispose.bind(response);
      response.dispose = async () => {
        await dispose();
        if (mode.endsWith("dispose")) throw new Error(mode === "own-dispose" ? reason : "Target page, context or browser has been closed");
      };
      if (mode !== "generic-fulfill") { entered.resolve(); await release.promise; }
      return response;
    };
    const register = context.route.bind(context);
    context.route = async (url, handler, options) => register(url, async (route, request) => {
      if (new URL(request.url()).pathname === "/api/rwa-pairs") {
        const fulfill = route.fulfill.bind(route);
        route.fulfill = async options => {
          fulfillCalls++;
          if (mode === "generic-fulfill") { entered.resolve(); await release.promise; throw new Error("Target page, context or browser has been closed"); }
          return fulfill(options);
        };
      }
      return handler(route, request);
    }, options);
    const policy = await installReadonlyPolicy(context, app.origin);
    try {
      const page = await context.newPage(); await page.goto(app.origin);
      await page.evaluate(() => { void fetch("/api/rwa-pairs").catch(() => {}); }); await entered.promise;
      const contextClosed = context.waitForEvent("close"); let settled = false;
      const closing = policy.close().then(() => { settled = true; });
      await contextClosed; expect(settled).toBe(false); release.resolve(); await closing;
      if (mode === "redirect") expect(policy.failures()).toContain("Redirect refused by readonly policy");
      else if (mode.startsWith("generic") || mode === "foreign-fetch") expect(policy.failures()).toContain("Readonly route failed unexpectedly");
      else expect(policy.failures()).toEqual([]);
      expect(fulfillCalls).toBe(mode === "generic-fulfill" ? 1 : 0);
      expect(policy.events.filter(e => e.action === "cancelled")).toHaveLength(["success", "own-fetch", "own-dispose"].includes(mode) ? 1 : 0);
      expect(sink.hits).toEqual([]);
      await info.attach("managed-error-control", { body: JSON.stringify({ mode, injectedScheduling: true, injectedError: mode !== "success" && mode !== "redirect", fulfillCalls, events: policy.events, failures: policy.failures() }), contentType: "application/json" });
    } finally { release.resolve(); await policy.close(); await Promise.all([app.close(), sink.close()]); }
  });
}

for (const fault of ["page-close", "context-close", "client-dispose", "early-page", "early-context", "foreign-dispose", "crash"] as const) {
  test(`managed ${fault} does not become a clean closure`, async ({ browser }) => {
    const app = await serve(); const context = await createReadonlyContext(browser);
    const policy = await installReadonlyPolicy(context, app.origin), transport = readonlyTransportFor(context)!;
    const rawClose = context.close.bind(context);
    let inducedCrash: Promise<unknown> | undefined;
    try {
      const page = await context.newPage(); await page.goto(app.origin);
      if (fault === "page-close") { const closePage = page.close.bind(page); page.close = async options => { await closePage(options); throw new Error("injected page close failure"); }; }
      if (fault === "context-close") context.close = async options => { await rawClose(options); throw new Error("injected context close failure"); };
      if (fault === "client-dispose") { const dispose = transport.client.dispose.bind(transport.client); transport.client.dispose = async options => { await dispose(options); throw new Error("injected client dispose failure"); }; }
      if (fault === "early-page") await page.close();
      if (fault === "early-context") await rawClose({ reason: "foreign-owner" });
      if (fault === "foreign-dispose") {
        await transport.client.dispose({ reason: "foreign-owner" });
        await page.evaluate(() => fetch("/api/rwa-pairs").catch(() => {}));
      }
      // A deliberate renderer crash via Playwright's public Chromium CDP session.
      // This is an induced lifecycle failure, not a naturally reproduced incident.
      if (fault === "crash") {
        const session = await context.newCDPSession(page);
        const crashed = page.waitForEvent("crash");
        inducedCrash = session.send("Page.crash").catch(() => {});
        await crashed;
      }
      const closing = policy.close(); expect(policy.close()).toBe(closing);
      if (["page-close", "context-close", "client-dispose"].includes(fault)) await expect(closing).rejects.toThrow("injected");
      else await closing;
      const message = {
        "page-close": "Readonly page close failed", "context-close": "Readonly context close failed",
        "client-dispose": "Readonly forwarding client dispose failed", "early-page": "Readonly page closed outside policy ownership",
        "early-context": "Readonly context closed outside policy ownership", "foreign-dispose": "Readonly route failed unexpectedly", "crash": "Readonly page crashed",
      }[fault];
      expect(policy.failures()).toContain(message);
      expect(context.pages()).toEqual([]);
    } finally { await rawClose(); await inducedCrash; await transport.close().catch(() => {}); await app.close(); }
  });
}

test("wallet stub fulfill is tracked across close and preserves generic errors", async ({ browser }) => {
  const app = await serve(), context = await createReadonlyContext(browser);
  const entered = deferred(), release = deferred();
  const register = context.route.bind(context);
  context.route = async (url, handler, options) => register(url, async (route, request) => {
    if (new URL(request.url()).pathname === "/api/wallet") route.fulfill = async () => {
      entered.resolve(); await release.promise; throw new Error("Target page, context or browser has been closed");
    };
    return handler(route, request);
  }, options);
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    await page.evaluate(() => { void fetch("/api/wallet?wallet=synthetic").catch(() => {}); }); await entered.promise;
    const closed = context.waitForEvent("close"), closing = policy.close(); await closed; release.resolve(); await closing;
    expect(policy.failures()).toContain("Readonly route failed unexpectedly");
    expect(app.hits).toEqual(["/"]);
  } finally { release.resolve(); await policy.close(); await app.close(); }
});


test("shutdown during async header acquisition never starts a new allowed hop", async ({ browser }) => {
  const app = await serve(), context = await createReadonlyContext(browser);
  const entered = deferred(), release = deferred(); let lateFetches = 0;
  const transport = readonlyTransportFor(context)!;
  const fetch = transport.client.fetch.bind(transport.client);
  transport.client.fetch = async (request, options) => {
    if (typeof request !== "string" && new URL(request.url()).pathname === "/api/rwa-pairs") lateFetches++;
    return fetch(request, options);
  };
  const register = context.route.bind(context);
  context.route = async (url, handler, options) => register(url, async (route, request) => {
    if (new URL(request.url()).pathname === "/api/rwa-pairs") {
      const allHeaders = request.allHeaders.bind(request);
      request.allHeaders = async () => { const headers = await allHeaders(); entered.resolve(); await release.promise; return headers; };
    }
    return handler(route, request);
  }, options);
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    await page.evaluate(() => { void fetch("/api/rwa-pairs").catch(() => {}); }); await entered.promise;
    const closed = context.waitForEvent("close"), closing = policy.close(); await closed; release.resolve(); await closing;
    expect(lateFetches).toBe(0); expect(app.hits).toEqual(["/"]);
    expect(policy.events.filter(e => e.action === "cancelled")).toHaveLength(1);
    expect(policy.failures()).toEqual([]);
  } finally { release.resolve(); await policy.close(); await app.close(); }
});
