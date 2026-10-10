import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BEAM_LOOKUP_ATTEMPTS,
  BEAM_LOOKUP_GAP_MS,
  BEAM_MIN_TIP_LAMPORTS,
  BEAM_TIP_ADDRESSES_URL,
  beamLandingUrl,
  beamTipInstruction,
  chooseBeamTransaction,
  fetchBeamLanding,
  fetchBeamTipAddress,
  formatBeamLanding,
  isBeamEnabled,
  lookupBeamAfterSend,
  measureTxSize,
  parseBeamLanding,
  parseTipAddresses,
} from "./solami-beam";

const LIVE_TIPS = [
  "15qWd4huAkoxvhDsHMfpUn27TW1YBYMMJJ2jkAkbeam",
  "9XuGciSwr5wb7dLTQm91JhuBTvj3GG8WjuRDc3obeam",
];

const payer = new PublicKey("11111111111111111111111111111111");

function tinyTx(extra: boolean) {
  const tip = new PublicKey(LIVE_TIPS[0]!);
  const ixs = extra
    ? [
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: tip, lamports: 1 }),
        beamTipInstruction(payer, tip),
      ]
    : [SystemProgram.transfer({ fromPubkey: payer, toPubkey: tip, lamports: 1 })];
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: ixs,
    }).compileToV0Message(),
  );
}

describe("isBeamEnabled", () => {
  it("is on only when SOLAMI_API_KEY is set and SOLAMI_BEAM is not off", () => {
    expect(isBeamEnabled({})).toBe(false);
    expect(isBeamEnabled({ SOLAMI_API_KEY: "k" })).toBe(true);
    expect(isBeamEnabled({ SOLAMI_API_KEY: "k", SOLAMI_BEAM: "0" })).toBe(false);
    expect(isBeamEnabled({ SOLAMI_API_KEY: "k", SOLAMI_BEAM: "false" })).toBe(false);
    expect(isBeamEnabled({ SOLAMI_API_KEY: "k", SOLAMI_BEAM: "1" })).toBe(true);
  });
});

describe("parseTipAddresses", () => {
  it("reads the live public array shape", () => {
    expect(parseTipAddresses(LIVE_TIPS)).toEqual(LIVE_TIPS);
  });

  it("accepts { addresses } and drops invalid keys", () => {
    expect(parseTipAddresses({ addresses: [LIVE_TIPS[0], "nope", 1] })).toEqual([LIVE_TIPS[0]]);
    expect(parseTipAddresses(null)).toEqual([]);
  });
});

describe("parseBeamLanding / formatBeamLanding", () => {
  it("reads the documented swqos/tx fields", () => {
    const landing = parseBeamLanding({
      signature: "sig",
      is_landed: true,
      landed_via_jito: false,
      region: "NYC",
      tip_lamports: 100000,
      tip_address: LIVE_TIPS[0],
    });
    expect(landing).toMatchObject({ isLanded: true, region: "NYC", tipLamports: 100_000 });
    expect(formatBeamLanding(landing!)).toBe("Landed via Beam · NYC · 100000 lamports");
  });

  it("treats missing/false is_landed as not landed", () => {
    expect(parseBeamLanding({ signature: "sig", is_landed: false })?.isLanded).toBe(false);
    expect(parseBeamLanding({ message: "not found!" })).toBeNull();
  });
});

describe("chooseBeamTransaction / measureTxSize", () => {
  it("keeps the tip when the message still fits", () => {
    const without = tinyTx(false);
    const withTip = tinyTx(true);
    expect(measureTxSize(withTip)).toBeGreaterThan(0);
    const chosen = chooseBeamTransaction(without, withTip);
    expect(chosen.included).toBe(true);
    expect(chosen.transaction).toBe(withTip);
  });

  it("falls back when the tipped message is oversize or missing", () => {
    const without = tinyTx(false);
    expect(chooseBeamTransaction(without, null)).toEqual({
      transaction: without,
      included: false,
      skippedReason: "no-tip-address",
    });
    const huge = {
      serialize: () => new Uint8Array(1_300),
    } as unknown as VersionedTransaction;
    const fallback = chooseBeamTransaction(without, huge);
    expect(fallback.included).toBe(false);
    expect(fallback.skippedReason).toBe("oversize");
    expect(fallback.transaction).toBe(without);
  });
});

describe("fetchBeamTipAddress / fetchBeamLanding", () => {
  it("does not fetch tips when Beam is disabled", async () => {
    const fetcher = vi.fn();
    await expect(fetchBeamTipAddress({ env: {}, fetcher })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("picks a live-shaped tip address", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(LIVE_TIPS), { status: 200 }));
    const tip = await fetchBeamTipAddress({ env: { SOLAMI_API_KEY: "k" }, fetcher });
    expect(tip?.lamports).toBe(BEAM_MIN_TIP_LAMPORTS);
    expect(LIVE_TIPS).toContain(tip?.address.toBase58());
    expect(fetcher).toHaveBeenCalledWith(BEAM_TIP_ADDRESSES_URL, expect.any(Object));
  });

  it("returns null on a 404 landing body", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: "not found!" }), { status: 404 }));
    await expect(fetchBeamLanding("sig", { fetcher })).resolves.toBeNull();
  });

  it("polls landing a bounded number of times and always returns beamLandingUrl", async () => {
    const waits: number[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: "not found!" }), { status: 404 }));
    const result = await lookupBeamAfterSend("sig123", {
      env: { SOLAMI_API_KEY: "k" },
      fetcher,
      nowWait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(BEAM_LOOKUP_ATTEMPTS);
    expect(waits).toEqual(Array.from({ length: BEAM_LOOKUP_ATTEMPTS - 1 }, () => BEAM_LOOKUP_GAP_MS));
    expect(result.beam).toBeNull();
    expect(result.beamLandingUrl).toBe(beamLandingUrl("sig123"));
  });
});
