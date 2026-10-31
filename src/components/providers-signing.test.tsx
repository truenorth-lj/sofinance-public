import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers, walletSupportsSignAndSend } from "./providers";
import { useWalletConnection, type WalletConnection } from "./wallet-connection";

const mocks = vi.hoisted(() => ({
  signTransaction: vi.fn(async (transaction: VersionedTransaction) => transaction),
  signAllTransactions: undefined as ((transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | undefined,
  sendTransaction: vi.fn(async () => "sig"),
  features: {} as Record<string, unknown>,
  connection: { id: "connection" },
}));
vi.mock("@/lib/engine-host", () => ({}));
vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
  WalletProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => ({ connection: mocks.connection }),
  useWallet: () => ({
    publicKey: undefined, connected: false, disconnect: vi.fn(), wallets: [],
    signTransaction: mocks.signTransaction, signAllTransactions: mocks.signAllTransactions,
    sendTransaction: mocks.sendTransaction, wallet: { adapter: { wallet: { features: mocks.features } } },
  }),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
  useWalletModal: () => ({ setVisible: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

function capture(): WalletConnection {
  let value: WalletConnection | undefined;
  function Reader() {
    value = useWalletConnection();
    return null;
  }
  renderToStaticMarkup(createElement(Providers, null, createElement(Reader)));
  if (!value) throw new Error("Wallet context missing");
  return value;
}

describe("browser batch wallet signing", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "");
    mocks.signTransaction.mockClear();
    mocks.signAllTransactions = undefined;
    mocks.features = {};
    mocks.sendTransaction.mockClear();
  });

  it("uses the adapter's batch method once for the complete transaction array", async () => {
    const transactions = [{ id: "a" }, { id: "b" }] as unknown as VersionedTransaction[];
    mocks.signAllTransactions = vi.fn(async (batch) => batch);
    await expect(capture().signAllTransactions!(transactions)).resolves.toBe(transactions);
    expect(mocks.signAllTransactions).toHaveBeenCalledExactlyOnceWith(transactions);
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it("omits unsupported batch signing without falling back to single signing", () => {
    expect(capture().signAllTransactions).toBeUndefined();
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it("exposes wallet send only when the wallet implements solana:signAndSendTransaction", async () => {
    expect(capture().signAndSendTransaction).toBeUndefined();
    mocks.features = { "solana:signAndSendTransaction": {} };
    const transaction = { id: "tx" } as unknown as VersionedTransaction;
    await expect(capture().signAndSendTransaction!(transaction)).resolves.toBe("sig");
    expect(mocks.sendTransaction).toHaveBeenCalledExactlyOnceWith(transaction, mocks.connection, { preflightCommitment: "confirmed" });
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it("detects Wallet Standard send support defensively", () => {
    expect(walletSupportsSignAndSend(undefined)).toBe(false);
    expect(walletSupportsSignAndSend({})).toBe(false);
    expect(walletSupportsSignAndSend({ wallet: { features: { "solana:signTransaction": {} } } })).toBe(false);
    expect(walletSupportsSignAndSend({ wallet: { features: { "solana:signAndSendTransaction": {} } } })).toBe(true);
  });
});
