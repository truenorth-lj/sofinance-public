import { expect, test as base } from "@playwright/test";
import bs58 from "bs58";
import { installFakeWallet } from "../fake-wallet/install";
import { FakeWallet, type FakeWalletOptions, type WalletMode } from "../fake-wallet/node-signer";
import { attachGuards, stubWalletApis, type Guards } from "../support/guards";

type Options = { walletMode: WalletMode; signAndSendError: FakeWalletOptions["signAndSendError"] | null };
type Fixtures = { wallet: FakeWallet; guards: Guards };

/**
 * `wallet`: a fresh random throwaway keypair per test (no funds, never persisted), installed as a Wallet Standard wallet.
 * `guards`: network allowlist + page/console error collection; the test fails in teardown if anything unexpected happened.
 * `context` installs the wallet and the API stubs before any page exists; `guards` is automatic.
 */
export const test = base.extend<Options & Fixtures>({
  walletMode: ["normal", { option: true }],
  signAndSendError: [null, { option: true }],
  wallet: async ({ walletMode, signAndSendError }, use) => {
    // E2E_TEST_KEY_B58 exists only so scripts/trace-secret-scan.mjs can plant a KNOWN throwaway key and prove it never
    // reaches a trace. Never point it at a funded key.
    const fixed = process.env.E2E_TEST_KEY_B58;
    await use(new FakeWallet({ mode: walletMode, slowMs: 1500, secretKey: fixed ? bs58.decode(fixed) : undefined,
      signAndSendError: signAndSendError ?? undefined }));
  },
  context: async ({ context, wallet }, use) => {
    await installFakeWallet(context, wallet);
    await stubWalletApis(context, wallet.address);
    await use(context);
  },
  guards: [async ({ context, page, baseURL }, use) => {
    const guards = await attachGuards(context, page, new URL(baseURL ?? "http://localhost").origin);
    await use(guards);
    expect.soft(guards.failures(), "unexpected network hosts, page errors or console errors").toEqual([]);
  }, { auto: true }],
});

export { expect };
