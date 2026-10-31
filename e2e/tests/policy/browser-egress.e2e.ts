import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { installReadonlyPolicy } from "../../support/readonly-policy";

test("external synthetic getBalance never reaches loopback provider", async ({ browser }) => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.method ?? "");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end("{}");
  });
  const originServer = createServer((_req, res) => res.end("<!doctype html><title>Origin</title>"));
  const listen = async (s: Server) => {
    await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("No address");
    return `http://127.0.0.1:${address.port}`;
  };
  const sink = await listen(server);
  const origin = await listen(originServer);
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const policy = await installReadonlyPolicy(context, origin);
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(async url => {
      await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["synthetic-only"] }) }).catch(() => {});
    }, sink);
    expect(hits).toEqual([]);
    expect(policy.failures()).toEqual([]);
    expect(policy.events.filter(e => e.scope === "external")).toHaveLength(1);
  } finally {
    await context.close();
    await Promise.all([server, originServer].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
});

type Hit = { method: string; path: string; rpc?: string };
async function loopback() {
  const hits: Hit[] = [];
  const upgrades: string[] = [];
  let redirect = "";
  let workerTarget = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let rpc: string | undefined;
    try { rpc = JSON.parse(body).method; } catch { /* non-JSON control */ }
    const path = new URL(req.url!, "http://loopback").pathname;
    hits.push({ method: req.method!, path, ...(rpc ? { rpc } : {}) });
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (redirect && path === "/app/plan") {
      res.writeHead(302, { location: redirect }); res.end(); return;
    }
    if (path === "/_next/static/sw.js") {
      res.setHeader("content-type", "application/javascript");
      res.setHeader("service-worker-allowed", "/");
      res.end(`self.addEventListener('install', e => e.waitUntil(fetch(${JSON.stringify(workerTarget)})));`); return;
    }
    if (path === "/" || path === "/app") {
      res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Healthy origin</title>"); return;
    }
    res.setHeader("content-type", "application/json"); res.end('{"healthy":true}');
  });
  server.on("upgrade", (req, socket) => { upgrades.push(req.url!); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    origin: `http://127.0.0.1:${address.port}`, hits, upgrades,
    redirect: (value: string) => { redirect = value; },
    workerTarget: (value: string) => { workerTarget = value; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const local = test.extend<{ servers: { app: Awaited<ReturnType<typeof loopback>>; sink: Awaited<ReturnType<typeof loopback>> } }>({
  servers: async ({}, use) => { // eslint-disable-line no-empty-pattern
    const app = await loopback(); const sink = await loopback();
    try { await use({ app, sink }); } finally { await Promise.all([app.close(), sink.close()]); }
  },
});

local("disabled guard control: sink and zero-egress assertion detect getBalance", async ({ browser, servers: { app, sink } }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    await page.evaluate(async url => { await fetch(url, { method: "POST", body: JSON.stringify({ method: "getBalance" }) }); }, sink.origin);
    expect(sink.hits).toEqual([{ method: "POST", path: "/", rpc: "getBalance" }]);
    expect(() => expect(sink.hits).toEqual([])).toThrow();
  } finally { await context.close(); }
});

local("GET POST beacon and popup blocked; healthy origin and wallet stubs work", async ({ browser, servers: { app, sink } }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    expect(await page.title()).toBe("Healthy origin");
    const result = await page.evaluate(async url => {
      for (const path of ["/get?secret=do-not-log", "/api/wallet?wallet=private", "/api/token-metadata"]) {
        await fetch(url + path).catch(() => {});
      }
      await fetch(url + "/post", { method: "POST", body: '{"method":"getBalance"}' }).catch(() => {});
      navigator.sendBeacon(url + "/beacon", "do-not-log");
      window.open(url + "/popup");
      return {
        healthy: await (await fetch("/api/rwa-pairs")).json(),
        wallet: await (await fetch("/api/wallet?wallet=synthetic")).json(),
        tokens: await (await fetch("/api/token-metadata", { method: "POST", body: "{}" })).json(),
      };
    }, sink.origin);
    expect(result.healthy).toEqual({ healthy: true });
    expect(result.wallet.positions).toEqual([]); expect(result.tokens).toEqual({});
    await expect.poll(() => policy.events.filter(e => e.scope === "external" && e.action === "blocked").length).toBe(6);
    expect(sink.hits).toEqual([]);
    expect(app.hits.filter(hit => ["/api/wallet", "/api/token-metadata"].includes(hit.path))).toEqual([]);
    expect(policy.failures()).toEqual([]);
    expect(JSON.stringify(policy.events)).not.toContain("do-not-log");
    expect(JSON.stringify(policy.events)).not.toContain("private");
  } finally { await context.close(); }
});

for (const destination of ["external", "same-origin"] as const) {
  local(`redirect ${destination} is refused before following any hop`, async ({ browser, servers: { app, sink } }) => {
    app.redirect(destination === "external" ? sink.origin + "/redirected" : app.origin + "/api/selected-prepare");
    const context = await browser.newContext({ serviceWorkers: "block" });
    const policy = await installReadonlyPolicy(context, app.origin);
    try {
      const page = await context.newPage(); await page.goto(app.origin);
      await page.evaluate(() => fetch("/app/plan").catch(() => {}));
      expect(app.hits.filter(h => h.path === "/app/plan")).toHaveLength(1);
      expect(app.hits.some(h => h.path === "/api/selected-prepare")).toBe(false);
      expect(sink.hits).toEqual([]);
      expect(policy.failures()).toEqual(["Redirect refused by readonly policy"]);
    } finally { await context.close(); }
  });
}

local("financial, provider proxy, unknown APIs and non-smoke tokens abort and fail the audit", async ({ browser, servers: { app } }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    const paths = ["selected-prepare", "tx-send", "selected-broadcast", "rpc", "mcp", "new-financial-route", "verify-sign-token"];
    await page.evaluate(async paths => {
      for (const path of paths) await fetch("/api/" + path, { method: "POST", body: '{"token":"not-authorized"}' }).catch(() => {});
      await fetch("/api/selected-prepare").catch(() => {});
    }, paths);
    expect(policy.failures()).toHaveLength(paths.length + 1);
    expect(app.hits.filter(h => h.path.startsWith("/api/"))).toEqual([]);
    expect(policy.events.filter(e => e.action === "forwarded" && e.scope !== "public-read")).toEqual([]);
  } finally { await context.close(); }
});

local("WebSocket handshakes blocked on both origins; disabled control reaches the sink", async ({ browser, servers: { app, sink } }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    for (const url of [app.origin, sink.origin]) {
      await page.evaluate(url => new Promise<void>(resolve => {
        const ws = new WebSocket(url.replace("http:", "ws:")); ws.onclose = () => resolve(); ws.onerror = () => resolve();
      }), url);
    }
    expect(policy.events.filter(e => e.scope === "websocket")).toHaveLength(2);
    expect(app.upgrades).toEqual([]); expect(sink.upgrades).toEqual([]);
    expect(policy.failures()).toEqual([]);
  } finally { await context.close(); }
  const unguarded = await browser.newContext();
  try {
    const page = await unguarded.newPage(); await page.goto(app.origin);
    await page.evaluate(url => new Promise<void>(resolve => {
      const ws = new WebSocket(url.replace("http:", "ws:")); ws.onerror = () => resolve();
    }), sink.origin);
    expect(sink.upgrades).toEqual(["/"]);
  } finally { await unguarded.close(); }
});

local("serviceWorkers:block prevents registration and worker egress; enabled control reaches sink", async ({ browser, servers: { app, sink } }) => {
  app.workerTarget(sink.origin + "/service-worker");
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    // Playwright blocks registration (the returned promise need not settle).
    await page.evaluate(() => { void navigator.serviceWorker.register("/_next/static/sw.js"); });
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(context.serviceWorkers()).toEqual([]);
    expect(app.hits.filter(h => h.path.endsWith("sw.js"))).toEqual([]);
    expect(sink.hits).toEqual([]); expect(policy.failures()).toEqual([]);
  } finally { await context.close(); }
  const unguarded = await browser.newContext({ serviceWorkers: "allow" });
  try {
    const page = await unguarded.newPage(); await page.goto(app.origin);
    await page.evaluate(() => navigator.serviceWorker.register("/_next/static/sw.js"));
    await expect.poll(() => sink.hits.filter(h => h.path === "/service-worker").length).toBe(1);
  } finally { await unguarded.close(); }
});

local("APIRequestContext is outside routing; late override is detected, not falsely certified", async ({ browser, servers: { app, sink } }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, app.origin);
  try {
    await context.request.get(sink.origin + "/direct-api", { maxRedirects: 0 });
    expect(sink.hits.filter(h => h.path === "/direct-api")).toHaveLength(1);
    expect(policy.events).toEqual([]); // Not represented as protected browser traffic.
    await context.route(sink.origin + "/bypass", route => route.continue());
    const page = await context.newPage(); await page.goto(app.origin);
    await page.goto(sink.origin + "/bypass");
    expect(sink.hits.filter(h => h.path === "/bypass")).toHaveLength(1);
    expect(policy.failures()).toContain("Forbidden browser response observed (routing bypass)");
    expect(policy.failures()).toContain("Forbidden request was not intercepted; transport outcome unknown");
  } finally { await context.close(); }
});

local("CSP blocks dedicated and shared workers; unguarded worker HTTP and WebSocket controls reach sink", async ({ browser, servers: { app, sink } }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await installReadonlyPolicy(context, app.origin);
  try {
    const page = await context.newPage(); await page.goto(app.origin);
    const blocked = await page.evaluate(async url => {
      const script = URL.createObjectURL(new Blob([
        `fetch(${JSON.stringify(url + "/worker")}); new WebSocket(${JSON.stringify(url.replace("http:", "ws:"))});`,
      ], { type: "application/javascript" }));
      const violations = new Promise<string[]>(resolve => {
        const directives: string[] = [];
        document.addEventListener("securitypolicyviolation", event => {
          directives.push(event.effectiveDirective);
          if (directives.length === 2) resolve(directives);
        });
      });
      new Worker(script);
      new SharedWorker(script);
      return await violations;
    }, sink.origin);
    expect(blocked).toEqual(["worker-src", "worker-src"]);
    expect(sink.hits).toEqual([]); expect(sink.upgrades).toEqual([]);
  } finally { await context.close(); }
  const unguarded = await browser.newContext();
  try {
    const page = await unguarded.newPage(); await page.goto(app.origin);
    await page.evaluate(url => new Promise<void>(resolve => {
      const worker = new Worker(URL.createObjectURL(new Blob([
        `fetch(${JSON.stringify(url + "/worker")}).then(() => { const ws = new WebSocket(${JSON.stringify(url.replace("http:", "ws:"))}); ws.onclose = ws.onerror = () => postMessage('done'); });`,
      ], { type: "application/javascript" })));
      worker.onmessage = () => { worker.terminate(); resolve(); };
    }), sink.origin);
    expect(sink.hits.filter(h => h.path === "/worker")).toHaveLength(1);
    expect(sink.upgrades).toEqual(["/"]);
  } finally { await unguarded.close(); }
});
