// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { buildTransaction, testKeypair } from "@/lib/test-support/send-fixtures";

vi.mock("@/lib/sentry/client-tx", () => ({ captureTxClientFailure: vi.fn(), captureTxWalletErrorLanded: vi.fn() }));
vi.mock("@/lib/position-history-refresh", () => ({ notifyPositionHistoryChange: vi.fn() }));

import { getTxNotices, resetCancelChecks, resetTxNotices, runTx, sendAndTrack, type FindLanded, type TxFlow, type TxWallet } from "./index";

/**
 * A normal send must never ask the wallet to sign a message. The only signMessage in the app is the explicit
 * "Sign" button on the /ai MCP card (plus the wallet-provider plumbing that exposes the capability).
 */
const ALLOWED = new Set([
  "src/components/mcp-connection-card.tsx",
  "src/components/providers.tsx",
  "src/components/mobile-wallet-provider.tsx",
  "src/components/wallet-connection.tsx",
  "src/lib/appkit-wallet.ts",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const payer = testKeypair(61);
const WALLET = payer.publicKey.toBase58();
const SIG = bs58.encode(new Uint8Array(64).fill(7));
const LANDED = bs58.encode(new Uint8Array(64).fill(8));
const prepared = () => ({ transaction: buildTransaction({ payer, signWith: [] }), lastValidBlockHeight: 77, sendPermit: "permit", landedPermit: "check" });

/** A wallet that exposes signMessage, as Jupiter, Phantom and AppKit do: it must never be called by a send. */
function walletWithSignMessage(send: TxWallet["signAndSendTransaction"]) {
  const signMessage = vi.fn(async (message: Uint8Array) => message);
  const wallet = {
    address: WALLET, signMessage,
    signTransaction: vi.fn(async (tx: VersionedTransaction) => { const out = VersionedTransaction.deserialize(tx.serialize()); out.sign([payer]); return out; }),
    signAndSendTransaction: send,
  };
  return wallet;
}

beforeEach(() => { resetTxNotices(); resetCancelChecks(); });

describe("no signMessage in transaction flows", () => {
  it("only the MCP sign button and wallet plumbing reference signMessage in app source", () => {
    const root = process.cwd();
    const users = sourceFiles(join(root, "src")).filter((path) => /\bsignMessage\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).split("\\").join("/"));
    expect(users.filter((path) => !ALLOWED.has(path))).toEqual([]);
    // The tx pipeline and send/landed routes never mention it at all.
    expect(users.some((path) => /tx-pipeline|tx-send|tx-landed|transactions\//.test(path))).toBe(false);
  });

  const flows: TxFlow[] = ["add", "open", "withdraw", "compound", "swap"];
  it.each(flows)("%s: a successful send never calls signMessage", async (flow) => {
    const wallet = walletWithSignMessage(vi.fn(async () => SIG));
    const result = flow === "add" || flow === "open"
      ? await runTx({ flow, successTitle: "ok", prepare: async () => prepared() }, {}, { wallet })
      : await sendAndTrack({ flow, successTitle: "ok", wallet, prepared: prepared() });
    expect(result.signature).toBe(SIG);
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });

  it.each(flows)("%s: the sign-then-relay path never calls signMessage", async (flow) => {
    const wallet = walletWithSignMessage(undefined);
    const sendRaw = vi.fn(async (signed: VersionedTransaction) => bs58.encode(signed.signatures[0]!));
    await sendAndTrack({ flow, successTitle: "ok", wallet, prepared: prepared(), sendRaw });
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });

  it.each(flows)("%s: a wallet cancel after broadcast (Jupiter) is checked on Solana, shown as success, never failed, and never signs a message", async (flow) => {
    const wallet = walletWithSignMessage(vi.fn(async (): Promise<string> => { throw Object.assign(new Error("Request rejected by user"), { code: 4001 }); }));
    const findLanded = vi.fn<FindLanded>(async () => ({ status: "landed", signature: LANDED }));
    const result = await sendAndTrack({ flow, successTitle: "ok", wallet, prepared: prepared(), findLanded });
    expect(result).toMatchObject({ signature: LANDED, landedAfterWalletError: true });
    expect(getTxNotices().some((notice) => notice.state === "failure")).toBe(false);
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });
});
