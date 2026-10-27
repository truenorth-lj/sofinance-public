import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { expect, test } from '@playwright/test';
import { installReadonlyPolicy } from "../../support/readonly-policy";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No port');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

for (const disposal of ["success", "generic-error", "own-cancellation"] as const) {
test(`response acquired before shutdown avoids late delivery: dispose=${disposal}`, async ({ browser }, info) => {
  const arrived = deferred(), settled = deferred(), fetched = deferred(), resume = deferred();
  let response!: ServerResponse; let lateFulfillCalls = 0; let reason = "";
  const server = await serve((req, res) => { if (req.url === '/api/rwa-pairs') { response = res; arrived.resolve(); } else res.end('<title>healthy</title>'); });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // Public API scheduling injection: hold final context.close until the real HTTP callback
  // finishes. No synthetic errors, replacement responses or private SDK changes.
  const register = context.route.bind(context);
  context.route = async (url, handler, options) => register(url, async (route, request) => {
    if (new URL(request.url()).pathname === '/api/rwa-pairs') {
      const fetch = route.fetch.bind(route); route.fetch = async options => { const response = await fetch(options);
        const dispose = response.dispose.bind(response);
        response.dispose = async () => {
          await dispose();
          if (disposal !== "success") throw new Error(disposal === "own-cancellation" ? reason : "Target page, context or browser has been closed");
        };
        fetched.resolve(); await resume.promise; return response; };
      const fulfill = route.fulfill.bind(route); route.fulfill = async options => { lateFulfillCalls++; return fulfill(options); };
    }
    try { await handler(route, request); } finally { if (new URL(request.url()).pathname === '/api/rwa-pairs') settled.resolve(); }
  }, options);
  const close = context.close.bind(context);
  context.close = async options => { reason = options?.reason ?? ""; await context.cookies(); resume.resolve(); await settled.promise; await close(options); };
  const policy = await installReadonlyPolicy(context, server.origin);
  try {
    const page = await context.newPage(); await page.goto(server.origin);

    await page.evaluate(() => { void fetch('/api/rwa-pairs').catch(() => {}); }); await arrived.promise; response.end('{"healthy":true}'); await fetched.promise;
    await policy.close();
    await info.attach('audit', { body: JSON.stringify({ lateFulfillCalls, events: policy.events, failures: policy.failures() }), contentType: 'application/json' });
    expect(lateFulfillCalls).toBe(0);
    expect(policy.events.filter(e => e.action === "cancelled")).toHaveLength(disposal === "generic-error" ? 0 : 1);
    if (disposal === "generic-error") expect(policy.failures()).toContain("Readonly route failed unexpectedly");
    else expect(policy.failures()).toEqual([]);
  } finally { resume.resolve(); settled.resolve(); await close(); await server.close(); }
});


}

for (const scope of ["telemetry", "external", "forbidden"] as const) {
  test(`request-event closure preserves unentered ${scope} as UNKNOWN`, async ({ browser }, info) => {
    const hits: string[] = [];
    const sinkHits: string[] = [];
    const server = await serve((req, res) => { hits.push(req.url!); res.end("<title>healthy</title>"); });
    const sink = await serve((req, res) => { sinkHits.push(req.url!); res.end("{}"); });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const policy = await installReadonlyPolicy(context, server.origin);
    const started = deferred();
    let closing: Promise<void> | undefined;
    const target = scope === "external" ? sink.origin + "/synthetic" : server.origin + (scope === "telemetry" ? "/lumen/synthetic" : "/api/selected-prepare");
    try {
      const page = await context.newPage(); await page.goto(server.origin);
      // Scheduling injection through a public event: close before the SDK dispatches
      // this route. This reproduces the skipped-handler mechanism, not a transport escape.
      context.on("request", request => {
        if (request.url() === target) { closing = policy.close(); started.resolve(); }
      });
      await page.evaluate(url => { void fetch(url).catch(() => {}); }, target).catch(() => {});
      await started.promise; await closing;
      expect(policy.failures()).toContain("Forbidden request was not intercepted; transport outcome unknown");
      expect(policy.events.filter(event => event.scope === scope && event.action === "blocked")).toEqual([]);
      expect(policy.unhandledRequests()).toEqual([{
        ordinal: 1, scope, host: "127.0.0.1", method: "GET", resource: "fetch", observedDuring: "running", outcome: "unknown",
      }]);
      expect(hits).toEqual(["/"]); expect(sinkHits).toEqual([]);
      expect(() => expect(policy.failures()).toEqual([])).toThrow();
      await info.attach("unknown-with-zero-sink", { body: JSON.stringify({ unhandled: policy.unhandledRequests(), failures: policy.failures(), hits, sinkHits }), contentType: "application/json" });
    } finally { await policy.close(); await Promise.all([server.close(), sink.close()]); }
  });
}

test("healthy public response is delivered before shutdown and guard-disabled destinations reach sinks", async ({ browser }) => {
  const hits: string[] = [];
  const sinkHits: string[] = [];
  const server = await serve((req, res) => {
    hits.push(req.url!); res.setHeader("content-type", req.url === "/" ? "text/html" : "application/json");
    res.end(req.url === "/" ? "<title>healthy</title>" : '{"healthy":true}');
  });
  const sink = await serve((req, res) => { sinkHits.push(req.url!); res.setHeader("access-control-allow-origin", "*"); res.end("{}"); });
  try {
    for (const guarded of [true, false]) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      const policy = guarded ? await installReadonlyPolicy(context, server.origin) : undefined;
      try {
        const page = await context.newPage(); await page.goto(server.origin);
        expect(await page.evaluate(() => fetch("/api/rwa-pairs").then(r => r.json()))).toEqual({ healthy: true });
        await page.evaluate(async sink => {
          await Promise.all(["/lumen/synthetic", "/api/selected-prepare", sink + "/external"].map(url => fetch(url).catch(() => {})));
        }, sink.origin);
        if (policy) {
          await policy.close();
          expect(policy.events.filter(event => event.action === "cancelled")).toEqual([]);
          expect(policy.failures()).toEqual(["Operation outside readonly browser scope was attempted"]);
          expect(sinkHits).toEqual([]);
          expect(hits).toEqual(["/", "/api/rwa-pairs"]);
        } else {
          expect(sinkHits).toEqual(["/external"]);
          expect(hits).toContain("/lumen/synthetic"); expect(hits).toContain("/api/selected-prepare");
        }
      } finally { if (policy) await policy.close(); else await context.close(); }
    }
  } finally { await Promise.all([server.close(), sink.close()]); }
});
