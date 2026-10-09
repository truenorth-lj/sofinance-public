import { describe, expect, it, vi } from "vitest";
import type { VersionedTransaction } from "@solana/web3.js";
import {
  APPKIT_FEATURES,
  APPKIT_THEME_MODE,
  APPKIT_THEME_VARIABLES,
  FEATURED_SOLANA_WALLET_IDS,
  appKitSignMessage,
  signAppKitTransaction,
  type AppKitSolanaWalletProvider,
} from "./appkit-wallet";

function fakeTx(id: string) {
  return { id } as unknown as VersionedTransaction;
}

function extensionProvider(overrides: Partial<AppKitSolanaWalletProvider> = {}): AppKitSolanaWalletProvider {
  return {
    signTransaction: vi.fn(async (transaction) => transaction),
    signMessage: vi.fn(async (message) => new Uint8Array(message)),
    ...overrides,
  };
}

function walletConnectProvider(overrides: Partial<AppKitSolanaWalletProvider> = {}): AppKitSolanaWalletProvider {
  return {
    signTransaction: vi.fn(async (transaction) => {
      const signed = fakeTx("wc-signed");
      Object.assign(signed, transaction, { signedVia: "walletconnect" });
      return signed;
    }),
    signMessage: vi.fn(async (message) => {
      const signature = new Uint8Array(64);
      signature.set(message.subarray(0, Math.min(message.length, 64)));
      return signature;
    }),
    ...overrides,
  };
}

describe("AppKit Solana wallet config", () => {
  it("features Solana wallets and keeps analytics/email/socials off with a dark Ink theme", () => {
    expect(FEATURED_SOLANA_WALLET_IDS).toHaveLength(6);
    expect(new Set(FEATURED_SOLANA_WALLET_IDS).size).toBe(6);
    expect(APPKIT_FEATURES).toEqual({ analytics: false, email: false, socials: [] });
    expect(APPKIT_THEME_MODE).toBe("dark");
    expect(APPKIT_THEME_VARIABLES["--apkt-accent"]).toBe("#f5f5f5");
    expect(APPKIT_THEME_VARIABLES["--apkt-color-mix"]).toBe("#050505");
  });
});

describe("signAppKitTransaction", () => {
  it("signs through a Wallet Standard extension walletProvider", async () => {
    const transaction = fakeTx("unsigned");
    const provider = extensionProvider();
    const signed = await signAppKitTransaction(provider, transaction);
    expect(signed).toBe(transaction);
    expect(provider.signTransaction).toHaveBeenCalledWith(transaction);
  });

  it("signs through a WalletConnect walletProvider", async () => {
    const transaction = fakeTx("unsigned");
    const provider = walletConnectProvider();
    const signed = await signAppKitTransaction(provider, transaction);
    expect(signed).toMatchObject({ id: "unsigned", signedVia: "walletconnect" });
    expect(provider.signTransaction).toHaveBeenCalledWith(transaction);
  });

  it("fails when the connected wallet cannot sign transactions", async () => {
    await expect(signAppKitTransaction({}, fakeTx("unsigned"))).rejects.toThrow(
      "Connected wallet does not support this transaction signing method",
    );
    await expect(signAppKitTransaction(undefined, fakeTx("unsigned"))).rejects.toThrow(
      "Connected wallet does not support this transaction signing method",
    );
  });
});

describe("appKitSignMessage", () => {
  it("signs through a Wallet Standard extension walletProvider", async () => {
    const message = new TextEncoder().encode("mcp-challenge");
    const provider = extensionProvider();
    const signMessage = appKitSignMessage(provider);
    expect(signMessage).toBeTypeOf("function");
    const signature = await signMessage!(message);
    expect(signature).toEqual(message);
    expect(provider.signMessage).toHaveBeenCalledWith(message);
  });

  it("signs through a WalletConnect walletProvider", async () => {
    const message = new TextEncoder().encode("mcp-challenge");
    const provider = walletConnectProvider();
    const signMessage = appKitSignMessage(provider);
    const signature = await signMessage!(message);
    expect(signature).toHaveLength(64);
    expect(signature.subarray(0, message.length)).toEqual(message);
    expect(provider.signMessage).toHaveBeenCalledWith(message);
  });

  it("is omitted when the wallet cannot sign messages", () => {
    expect(appKitSignMessage(undefined)).toBeUndefined();
    expect(appKitSignMessage({})).toBeUndefined();
    expect(appKitSignMessage({ signTransaction: async (transaction) => transaction })).toBeUndefined();
  });
});
