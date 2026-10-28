import { createServer, type ServerResponse } from "node:http";
import { test as readonlyTest, expect } from "../../support/readonly-fixture";

// Exercise the production fixture itself, including its finally audit/attachment.
// The app and HTTP response are real loopback I/O; no route methods are replaced.
const test = readonlyTest.extend<{ loopback: { origin: string; arrival: Promise<void>; response: () => ServerResponse } }>({
  loopback: async ({}, use) => { // eslint-disable-line no-empty-pattern
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    let response!: ServerResponse;
    const server = createServer((req, res) => {
      if (req.url === "/api/rwa-pairs") { response = res; arrived(); }
      else { res.setHeader("content-type", "text/html"); res.end("<nav>healthy</nav>"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    try { await use({ origin: `http://127.0.0.1:${address.port}`, arrival, response: () => response }); }
    finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
  },
  baseURL: async ({ loopback }, use) => { await use(loopback.origin); },
});

for (const releaseOnClose of [true, false]) {
  test(`real readonly fixture tears down ${releaseOnClose ? "late response" : "held transport"}`, async ({ page, loopback, wallet }) => {
    await page.goto("/");
    await expect(page.locator("nav")).toBeVisible();
    await page.evaluate(() => { void fetch("/api/rwa-pairs").catch(() => {}); });
    await loopback.arrival;
    if (releaseOnClose) page.once("close", () => loopback.response().end('{"healthy":true}'));
    expect(wallet.ledger).toEqual([]);
    // Return to the unmodified fixture order; its own finally must pass.
  });
}

// Playwright Test merges context options into new API clients. Merely creating a
// separate client is insufficient: the readonly fixture must explicitly unset proxy.
test("real readonly fixture separates direct API requests from the browser proxy", async ({ context, request, loopback, readonlyTransport }) => {
  const denied = await context.request.get(loopback.origin);
  expect(denied.status()).toBe(502);
  const direct = await request.get("/");
  expect(direct.status()).toBe(200);
  expect(await direct.text()).toContain("healthy");
  // The associated API client tunnels even its HTTP request through CONNECT.
  expect(readonlyTransport.audit().denied.connect).toBe(1);
});
