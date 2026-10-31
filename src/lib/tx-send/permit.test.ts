// Check permit for /api/tx-landed: own domain (a send permit is not one), bound to wallet, bytes and lastValidBlockHeight.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { issueTxLandedPermit, issueTxSendPermit, txPermitsFor, verifyTxLandedPermit, verifyTxSendPermit } from "./permit";

const payer = testKeypair(81);
const WALLET = payer.publicKey.toBase58();
const tx = buildTransaction({ payer, signWith: [] });
const bytes = tx.serialize();

describe("tx-landed check permit", () => {
  it("verifies only for the same wallet, bytes and lastValidBlockHeight", () => {
    const permit = issueTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 500);
    expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 500, permit)).toBe(true);
    expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 501, permit)).toBe(false);
    expect(verifyTxLandedPermit(SIGNING_SECRET, testKeypair(82).publicKey.toBase58(), bytes, 500, permit)).toBe(false);
    expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, buildTransaction({ payer, signWith: [], blockhash: "11111111111111111111111111111112" }).serialize(), 500, permit)).toBe(false);
    expect(verifyTxLandedPermit("another-secret", WALLET, bytes, 500, permit)).toBe(false);
    for (const bad of [undefined, "", "zz", 500.5, -1]) expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, bytes, bad, permit)).toBe(false);
  });
  it("is domain-separated from the relay send permit, both ways", () => {
    const send = issueTxSendPermit(SIGNING_SECRET, WALLET, bytes);
    const landed = issueTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 500);
    expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 500, send)).toBe(false);
    expect(verifyTxSendPermit(SIGNING_SECRET, WALLET, bytes, landed)).toBe(false);
  });
  it("txPermitsFor issues both, and no check permit without a valid height", () => {
    const b64 = toBase64(tx);
    const both = txPermitsFor(WALLET, b64, 500, SIGNING_SECRET);
    expect(verifyTxSendPermit(SIGNING_SECRET, WALLET, bytes, both.sendPermit)).toBe(true);
    expect(verifyTxLandedPermit(SIGNING_SECRET, WALLET, bytes, 500, both.landedPermit)).toBe(true);
    expect(txPermitsFor(WALLET, b64, undefined, SIGNING_SECRET)).toEqual({ sendPermit: both.sendPermit });
  });
});
