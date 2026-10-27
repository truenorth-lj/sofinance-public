import { expect, test as base } from "@playwright/test";
import { installFakeWallet } from "../fake-wallet/install";
import { FakeWallet } from "../fake-wallet/node-signer";
import { installReadonlyPolicy } from "./readonly-policy";

export const test = base.extend<{ wallet: FakeWallet }>({
  wallet: async ({}, use) => { await use(new FakeWallet()); },    // eslint-disable-line no-empty-pattern
  context: async ({ context, wallet, baseURL }, use, testInfo) => {
    const policy = await installReadonlyPolicy(context, baseURL!, wallet.address);
    await installFakeWallet(context, wallet);
    try { await use(context); } finally {
      await policy.close();
      await testInfo.attach("readonly-browser-policy", { body: JSON.stringify({ events: policy.events, failures: policy.failures(), unhandled: policy.unhandledRequests() }), contentType: "application/json" });
      expect(policy.failures()).toEqual([]);
      expect(policy.events.filter(event => event.action === "forwarded" && event.scope !== "public-read")).toEqual([]);
    }
  },
});

export { expect };
