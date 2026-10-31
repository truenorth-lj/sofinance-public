import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";
import type { FakeWallet } from "./node-signer";

const INPAGE = readFileSync(new URL("./inpage.js", import.meta.url), "utf8");

/**
 * Registers the fake Wallet Standard wallet in every page of the context, before any app script runs.
 * The page receives the public key and two functions that call back into Node; it never receives the secret key.
 * Works for both providers in src/components/providers.tsx (Reown AppKit and wallet-adapter) because both
 * auto-detect Wallet Standard wallets.
 */
export async function installFakeWallet(context: BrowserContext, wallet: FakeWallet) {
  await context.exposeBinding("__e2eSignTransaction", (_source, txB64: string, chain: string | null) =>
    wallet.signTransactionB64(txB64, chain));
  await context.exposeBinding("__e2eSignMessage", (_source, messageB64: string) => wallet.signMessageB64(messageB64));
  await context.addInitScript({
    content: `window.__E2E_WALLET_CFG__=${JSON.stringify({
      address: wallet.address, publicKey: [...wallet.publicKeyBytes], name: wallet.name,
      signAndSendError: wallet.signAndSendError })};`,
  });
  await context.addInitScript({ content: INPAGE });
}
