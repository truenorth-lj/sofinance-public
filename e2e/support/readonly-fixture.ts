import { expect, test as base } from "@playwright/test";
import { installFakeWallet } from "../fake-wallet/install";
import { FakeWallet } from "../fake-wallet/node-signer";
import { bindReadonlyTransport, createReadonlyTransport, type ReadonlyTransport } from "./readonly-transport";
import { installReadonlyPolicy } from "./readonly-policy";

export const test = base.extend<{ wallet: FakeWallet; readonlyTransport: ReadonlyTransport }>({
  wallet: async ({}, use) => { await use(new FakeWallet()); },    // eslint-disable-line no-empty-pattern
  readonlyTransport: async ({ ignoreHTTPSErrors }, use) => {
    const transport = await createReadonlyTransport(ignoreHTTPSErrors);
    try { await use(transport); } finally { await transport.close(); }
  },
  proxy: async ({ readonlyTransport }, use) => { await use(readonlyTransport.proxy); },
  // The public MCP request fixture must not inherit the browser deny proxy.
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL, proxy: undefined });
    try { await use(request); } finally { await request.dispose(); }
  },
  context: async ({ context, wallet, baseURL, readonlyTransport }, use, testInfo) => {
    bindReadonlyTransport(context, readonlyTransport);
    const policy = await installReadonlyPolicy(context, baseURL!, wallet.address);
    await installFakeWallet(context, wallet);
    try { await use(context); } finally {
      try { await policy.close(); } finally {
        await testInfo.attach("readonly-browser-policy", { body: JSON.stringify({ events: policy.events, failures: policy.failures(), unhandled: policy.unhandledRequests(), transport: policy.transportAudit() }), contentType: "application/json" });
      }
      expect(policy.failures()).toEqual([]);
      expect(policy.events.filter(event => event.action === "forwarded" && event.scope !== "public-read")).toEqual([]);
    }
  },
});

export { expect };
