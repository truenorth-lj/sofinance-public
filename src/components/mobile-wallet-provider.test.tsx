import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionedTransaction } from "@solana/web3.js";
import { FEATURED_SOLANA_WALLET_IDS, type AppKitSolanaWalletProvider } from "../lib/appkit-wallet";
import { MobileWalletProvider } from "./mobile-wallet-provider";
import { useWalletConnection, type WalletConnection } from "./wallet-connection";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  account: { address: undefined as string | undefined, isConnected: false },
  walletProvider: undefined as AppKitSolanaWalletProvider | undefined,
}));

vi.mock("@reown/appkit/react", () => ({
  createAppKit: vi.fn(),
  useAppKit: () => ({ open: mocks.open }),
  useAppKitAccount: () => mocks.account,
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
  useAppKitProvider: () => ({ walletProvider: mocks.walletProvider }),
}));

vi.mock("@reown/appkit-adapter-solana/react", () => ({
  SolanaAdapter: class SolanaAdapter {},
}));

vi.mock("@reown/appkit/networks", () => ({
  solana: { id: "solana:mainnet" },
}));

function fakeTx() {
  return { serialized: true } as unknown as VersionedTransaction;
}

function capture(): WalletConnection {
  let value: WalletConnection | null = null;
  function Reader() {
    value = useWalletConnection();
    return null;
  }
  renderToStaticMarkup(createElement(MobileWalletProvider, null, createElement(Reader)));
  if (!value) throw new Error("WalletConnectionContext was not provided");
  return value;
}

describe("MobileWalletProvider", () => {
  beforeEach(() => {
    mocks.open.mockClear();
    mocks.disconnect.mockClear();
    mocks.account.address = undefined;
    mocks.account.isConnected = false;
    mocks.walletProvider = undefined;
  });

  it("opens the AppKit Connect modal for the Solana namespace", () => {
    const connection = capture();
    connection.connect();
    expect(mocks.open).toHaveBeenCalledWith({ view: "Connect", namespace: "solana" });
    expect(connection.walletsCount).toBe(FEATURED_SOLANA_WALLET_IDS.length);
    expect(connection.isMobile).toBe(true);
  });

  it("signs transactions and messages via an extension walletProvider", async () => {
    const transaction = fakeTx();
    const message = new Uint8Array([1, 2, 3]);
    const signedTx = fakeTx();
    const signedMessage = new Uint8Array([9, 9, 9]);
    mocks.walletProvider = {
      signTransaction: vi.fn(async () => signedTx),
      signMessage: vi.fn(async () => signedMessage),
    };
    const connection = capture();
    await expect(connection.signTransaction(transaction)).resolves.toBe(signedTx);
    expect(connection.signMessage).toBeTypeOf("function");
    await expect(connection.signMessage!(message)).resolves.toBe(signedMessage);
    expect(mocks.walletProvider.signTransaction).toHaveBeenCalledWith(transaction);
    expect(mocks.walletProvider.signMessage).toHaveBeenCalledWith(message);
  });

  it("signs transactions and messages via a WalletConnect walletProvider", async () => {
    const transaction = fakeTx();
    const message = new TextEncoder().encode("sign-to-get-mcp-config");
    const signedTx = fakeTx();
    const signedMessage = new Uint8Array(64);
    mocks.walletProvider = {
      signTransaction: vi.fn(async () => signedTx),
      signMessage: vi.fn(async () => signedMessage),
    };
    const connection = capture();
    await expect(connection.signTransaction(transaction)).resolves.toBe(signedTx);
    await expect(connection.signMessage!(message)).resolves.toBe(signedMessage);
    expect(mocks.walletProvider.signTransaction).toHaveBeenCalledWith(transaction);
    expect(mocks.walletProvider.signMessage).toHaveBeenCalledWith(message);
  });

  it("omits signMessage when the AppKit walletProvider cannot sign messages", () => {
    mocks.walletProvider = { signTransaction: vi.fn(async (transaction) => transaction) };
    const connection = capture();
    expect(connection.signMessage).toBeUndefined();
  });

  it("enables the wallet list instead of connecting Jupiter only", () => {
    const src = readFileSync(resolve("src/components/mobile-wallet-provider.tsx"), "utf8");
    expect(src).toContain("enableWallets: true");
    expect(src).toContain('open({ view: "Connect", namespace: "solana" })');
    expect(src).toContain("new SolanaAdapter()");
    expect(src).not.toContain('connect("jupiter")');
    expect(src).not.toContain("enableWallets: false");
    expect(src).not.toContain("useAppKitWallet");
  });
});
