import { createServer, type RequestListener } from "node:http";
import { expect, test } from "@playwright/test";
import { createReadonlyContext } from "../../support/readonly-transport";
import { stubWalletApis } from "../../support/guards";
import { installReadonlyPolicy } from "../../support/readonly-policy";

async function serve(handler: RequestListener) {
  const upgrades: string[] = [];
  const server = createServer(handler);
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url!);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return {
    origin: `http://127.0.0.1:${address.port}`, upgrades,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("policy teardown settles a held allowed fetch without an unhandled rejection", async ({ browser }) => {
  let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const server = await serve((req, res) => {
    if (req.url === "/api/rwa-pairs") { arrived(); return; }
    res.end("<!doctype html><title>Healthy</title>");
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, server.origin);
  try {
    const page = await context.newPage(); await page.goto(server.origin);
    await page.evaluate(() => { void fetch("/api/rwa-pairs").catch(() => {}); });
    await arrival;
    await policy.close();
    expect(context.pages()).toEqual([]);
    expect(policy.events.filter(event => event.action === "cancelled")).toHaveLength(1);
    expect(policy.failures()).toEqual([]);
    await policy.close(); // The owning fixture may also close in its finally block.
  } finally { await policy.close(); await server.close(); }
});

test("an ordinary transport failure remains an audit failure", async ({ browser }) => {
  const server = await serve((req, res) => {
    if (req.url === "/api/rwa-pairs") { req.socket.destroy(); return; }
    res.end("<!doctype html><title>Healthy</title>");
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const policy = await installReadonlyPolicy(context, server.origin);
  try {
    const page = await context.newPage(); await page.goto(server.origin);
    await page.evaluate(() => fetch("/api/rwa-pairs").catch(() => {}));
    await policy.close();
    expect(policy.failures()).toContain("Readonly route failed unexpectedly");
    expect(policy.events.filter(event => event.action === "cancelled")).toEqual([]);
  } finally { await policy.close(); await server.close(); }
});

for (const managed of [false, true]) {
for (const iframe of [false, true]) {
  test(`stub ${iframe ? "iframe" : "document"} cannot start worker sockets; unguarded control can (proxy=${managed})`, async ({ browser }) => {
    const app = await serve((_req, res) => res.end("<!doctype html><title>Healthy</title>"));
    const sink = await serve((_req, res) => res.end("{}"));
    try {
      for (const guarded of [true, false]) {
        // Remove Chromium LNA as an independent reason for a zero loopback sink count.
        const context = guarded && managed
          ? await createReadonlyContext(browser, { permissions: ["local-network-access"] })
          : await browser.newContext({ serviceWorkers: "block", permissions: ["local-network-access"] });
        const policy = guarded ? await installReadonlyPolicy(context, app.origin) : undefined;
        if (!guarded) await stubWalletApis(context);
        try {
          const page = await context.newPage();
          await page.goto(app.origin + (iframe ? "/" : "/api/wallet?wallet=synthetic"));
          if (iframe) await page.evaluate(() => new Promise<void>(resolve => {
            const frame = document.createElement("iframe");
            frame.onload = () => resolve(); frame.src = "/api/wallet?wallet=synthetic";
            document.body.append(frame);
          }));
          const frame = iframe ? page.frames()[1]! : page.mainFrame();
          const messages = await frame.evaluate(url => new Promise<string[]>(resolve => {
            const messages: string[] = [];
            const source = `postMessage('started'); const ws = new WebSocket(${JSON.stringify(url.replace("http:", "ws:") + "/worker")}); ws.onclose = ws.onerror = () => postMessage('done');`;
            const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
            worker.onerror = () => { worker.terminate(); resolve(messages); };
            worker.onmessage = event => {
              messages.push(event.data);
              if (event.data === "done") { worker.terminate(); resolve(messages); }
            };
          }), sink.origin);
          expect(messages).toEqual(guarded ? [] : ["started", "done"]);
          expect(sink.upgrades).toEqual(guarded ? [] : ["/worker"]);
          if (policy) { await policy.close(); expect(policy.failures()).toEqual([]); }
        } finally { if (policy) await policy.close(); else await context.close(); }
      }
    } finally { await Promise.all([app.close(), sink.close()]); }
  });
}
}
