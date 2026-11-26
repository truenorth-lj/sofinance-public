// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { VersionedTransaction } from "@solana/web3.js";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { raydiumCompoundPrepared } from "@/lib/test-support/raydium-compound-prepared";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { useCompoundController } from "../../use-compound-controller";

/**
 * Compound-all PR1 regression: the Raydium compound transaction the wallet is asked to sign is byte-for-byte the one
 * `/api/compound-prepare` returned for that position. The snapshot was recorded on origin/main before the submit
 * was extracted into a per-position function, and must not change after it.
 */
const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
vi.mock("../../wallet-connection", () => ({ useWalletConnection: () => ({ address: wallet, connected: true, signTransaction: mocks.sign }) }));

let wallet: string;
let controller: ReturnType<typeof useCompoundController>;
let root: Root, container: HTMLDivElement;
let prepared: ReturnType<typeof raydiumCompoundPrepared>;
let relayed: Uint8Array[];
const positionMint = testKeypair(80).publicKey.toBase58();
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function Probe() {
  const value = useCompoundController({ wallet, positionMint, externalBlocked: false });
  useLayoutEffect(() => { controller = value; });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  const fixture = compoundHistoryFixture(); wallet = fixture.wallet;
  prepared = raydiumCompoundPrepared(positionMint);
  mocks.sign.mockReset(); relayed = [];
  mocks.sign.mockImplementation(async (tx: VersionedTransaction) => { tx.sign([testKeypair(1)]); return tx; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (url === "/api/compound-state") return Response.json({ ...fixture.state, positionMint });
    if (url === "/api/compound-prepare") return Response.json(prepared);
    if (url === "/api/tx-send") {
      const { VersionedTransaction: Tx } = await import("@solana/web3.js");
      const signed = Tx.deserialize(Buffer.from(body.signedTransaction ?? body.transaction, "base64"));
      relayed.push(signed.message.serialize());
      return Response.json({ signature: bs58.encode(signed.signatures[0]!) });
    }
    if (url === "/api/compound-confirm") return Response.json({ signature: body.attempt.signature, status: "pending", chainStatus: "pending", state: null });
    if (url === "/api/tx-status" || url === "/api/tx-landed") return Response.json({ status: "pending" });
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("Raydium compound bytes (compound-all refactor guard)", () => {
  it("the selected-position controller hands the wallet exactly the prepared transaction", async () => {
    await act(async () => root.render(createElement(Probe)));
    await advance(1); await advance(1); await advance(1);
    expect(controller.canCompound).toBe(true);
    await act(async () => controller.compound()); await advance(1);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    const asked = mocks.sign.mock.calls[0]![0] as VersionedTransaction;
    const preparedBytes = Buffer.from(prepared.unsignedTransaction, "base64");
    const { VersionedTransaction: Tx } = await import("@solana/web3.js");
    expect(Buffer.from(asked.message.serialize())).toEqual(Buffer.from(Tx.deserialize(preparedBytes).message.serialize()));
    // What reaches the relay is that same message, signed once by the wallet.
    expect(relayed.map((bytes) => sha256(bytes))).toEqual([sha256(asked.message.serialize())]);
    expect({ message: sha256(asked.message.serialize()), size: preparedBytes.length }).toMatchSnapshot();
  });
});
