import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { installReadonlyPolicy } from "../../support/readonly-policy";
import { createReadonlyContext, readonlyTransportFor } from "../../support/readonly-transport";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const primary of ["generic", "foreign", "undefined", "own"] as const) {
  for (const cleanup of ["success", "generic", "own"] as const) {
    test(`response errors survive cleanup: primary=${primary}, cleanup=${cleanup}`, async ({ browser }, info) => {
      const hits: string[] = [];
      const server = createServer((request, response) => {
        hits.push(request.url!);
        response.setHeader("content-type", "text/html");
        response.end("<nav>healthy</nav>");
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const context = await createReadonlyContext(browser);
      const transport = readonlyTransportFor(context)!;
      const entered = deferred(), release = deferred();
      let reason = "", deliveryErrors = 0, cleanupCalls = 0;
      const close = context.close.bind(context);
      context.close = async options => { reason = options?.reason ?? ""; return close(options); };
      const fetch = transport.client.fetch.bind(transport.client);
      transport.client.fetch = async (request, options) => {
        const response = await fetch(request, options);
        if (typeof request !== "string" && request.url().endsWith("/api/rwa-pairs")) {
          // Explicit public-method fault injection; the real response/client are still
          // disposed. This checks error classification, not a natural SDK incident.
          const dispose = response.dispose.bind(response);
          response.dispose = async () => {
            await dispose();
            cleanupCalls++;
            if (cleanup !== "success") throw new Error(cleanup === "own" ? reason : "GENERIC_CLEANUP_FAILURE");
          };
        }
        return response;
      };
      const register = context.route.bind(context);
      context.route = async (url, handler, options) => register(url, async (route, request) => {
        if (request.url().endsWith("/api/rwa-pairs")) {
          route.fulfill = async () => {
            entered.resolve();
            await release.promise;
            deliveryErrors++;
            if (primary === "undefined") throw undefined;
            throw new Error(primary === "own" ? reason : primary === "foreign"
              ? "Readonly policy shutdown foreign-owner" : "GENERIC_DELIVERY_FAILURE");
          };
        }
        await handler(route, request);
      }, options);
      const policy = await installReadonlyPolicy(context, origin);
      try {
        const page = await context.newPage();
        await page.goto(origin);
        await expect(page.locator("nav")).toHaveText("healthy");
        await page.evaluate(() => { void fetch("/api/rwa-pairs").catch(() => {}); });
        await entered.promise;
        const closed = context.waitForEvent("close");
        let completed = false;
        const closing = policy.close().then(() => { completed = true; });
        await closed;
        expect(completed).toBe(false);
        release.resolve();
        await closing;
        expect(reason).toMatch(/^Readonly policy shutdown /);
        expect(deliveryErrors).toBe(1);
        expect(cleanupCalls).toBe(1);
        expect(hits).toEqual(["/", "/api/rwa-pairs"]);
        const onlyOwnedCancellation = primary === "own" && cleanup !== "generic";
        if (onlyOwnedCancellation) expect(policy.failures()).toEqual([]);
        else expect(policy.failures()).toContain("Readonly route failed unexpectedly");
        expect(policy.events.filter(event => event.action === "cancelled")).toHaveLength(onlyOwnedCancellation ? 1 : 0);
        await info.attach("response-errors", { body: JSON.stringify({ primary, cleanup, deliveryErrors, cleanupCalls,
          failures: policy.failures(), events: policy.events }), contentType: "application/json" });
      } finally {
        release.resolve();
        await policy.close();
        await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
      }
    });
  }
}
