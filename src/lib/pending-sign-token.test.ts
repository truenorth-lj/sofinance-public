import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createSignToken, verifySignToken } from "./pending-sign-token";
import { buildOpenPositionUrl, buildSignUrl } from "./public-urls";

describe("open-position signUrl token", () => {
  it("round-trips an open-position pending sign payload", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const payload = {
      kind: "open-position" as const,
      wallet,
      unsignedTransaction: Buffer.from("fake-tx").toString("base64"),
      permit: "a".repeat(64),
      submitArgs: { permit: "a".repeat(64), wallet, summary: { operation: "open-position", nftMint: Keypair.generate().publicKey.toBase58() } },
      expiresAt: Date.now() + 60_000,
    };
    const token = await createSignToken(payload, "test-secret");
    const verified = await verifySignToken(token, "test-secret");
    expect(verified?.kind).toBe("open-position");
    expect(verified?.wallet).toBe(wallet);
    expect(verified?.submitArgs.summary).toEqual(payload.submitArgs.summary);
    expect(buildSignUrl(token)).toContain("/app/sign/");
  });

  it("rejects a token signed with a different secret or after expiry", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const token = await createSignToken({
      kind: "open-position",
      wallet,
      unsignedTransaction: "dHg=",
      permit: "b".repeat(64),
      submitArgs: { wallet },
      expiresAt: Date.now() + 60_000,
    }, "secret-a");
    expect(await verifySignToken(token, "secret-b")).toBeNull();
    const expired = await createSignToken({
      kind: "open-position",
      wallet,
      unsignedTransaction: "dHg=",
      permit: "b".repeat(64),
      submitArgs: { wallet },
      expiresAt: Date.now() - 1,
    }, "secret-a");
    expect(await verifySignToken(expired, "secret-a")).toBeNull();
  });

  it("builds an open-position deep link for a pool id", () => {
    const pool = Keypair.generate().publicKey.toBase58();
    expect(buildOpenPositionUrl(pool)).toBe(`/app/rwa-pairs?pool=${encodeURIComponent(pool)}&open=1`);
  });
});
