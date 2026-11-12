import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { PositionLookup } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { capabilitiesFor, NOT_AVAILABLE_MESSAGE, toolUnavailableReason } from "../model";
import { groupPositions, positionOptionLabel } from "../rows";
import { rhcCloseBlockReason, rhcPositionSource } from "./rhc";

const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const OWNER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const lookup = (tokenId: string, over: Partial<NonNullable<PositionLookup["position"]>> = {}): PositionLookup => ({
  tokenId, position: { tokenId, owner: OWNER, ownedByUser: true, liquidity: "1000", tickLower: -10, tickUpper: 10, poolId: POOL.poolId, baseSymbol: POOL.baseSymbol, ...over } as NonNullable<PositionLookup["position"]>,
});
const scanned = (tokenId: string, over: Partial<NonNullable<PositionLookup["position"]>> = {}): ScannedPosition => ({ ...lookup(tokenId, over), hooks: null, stablePair: true });

describe("rhcPositionSource", () => {
  it("wallet holdings first (scan order), then local ids the scan did not find, deduped", () => {
    const list = rhcPositionSource.fromDiscovery({ scanned: [scanned("9"), scanned("5")], lookups: [lookup("5"), lookup("12")] });
    expect(list.map((p) => [p.key, p.native.held !== null])).toEqual([["rhc-uniswap-v4:9", true], ["rhc-uniswap-v4:5", true], ["rhc-uniswap-v4:12", false]]);
    expect(list[0]).toMatchObject({ chain: "robinhood-chain", source: "rhc-uniswap-v4", poolId: POOL.poolId, rangeStatus: "unknown", liquidity: "1000" });
    expect(rhcPositionSource.fromDiscovery(null)).toEqual([]);
  });

  it("source capabilities: only a full Withdraw (Close); the other tools say 'Not available for this pool yet'", () => {
    const caps = rhcPositionSource.capabilities;
    expect(caps.withdraw).toEqual({ supported: true, partial: false });
    for (const tool of ["compound", "performance", "deposit"] as const) expect(toolUnavailableReason(caps, tool)).toBe(NOT_AVAILABLE_MESSAGE);
    expect(NOT_AVAILABLE_MESSAGE).toBe("Not available for this pool yet");
    expect(caps).toMatchObject({ rangeDisplay: "price", manualAdd: true, signer: "evm-wallet", exitPreview: { supported: true, output: "pool-tokens" } });
  });

  it("range as a price (5 significant digits, stable pair) with ticks kept on the native record", () => {
    const [p] = rhcPositionSource.fromDiscovery({ scanned: [scanned("7", { tickLower: -123, tickUpper: 77 })], lookups: [] });
    expect(p!.range).toEqual({ mode: "price", lower: 0.98778, upper: 1.0077, current: null });
    expect(p!.native.priceRange!.text).toBe(`0.98778–1.0077 ${POOL.currency1.symbol} per ${POOL.currency0.symbol}`);
    expect(rhcPositionSource.label(p!)).toMatch(/^#7 · .+ · range 0\.98778–1\.0077 SPCXon per SPCX$/);
  });

  it("unknown pool: tick range and a view-only reason", () => {
    const [p] = rhcPositionSource.fromDiscovery({ scanned: [], lookups: [lookup("3", { poolId: "0xdead" })] });
    expect(p!.range).toEqual({ mode: "tick", tickLower: -10, tickUpper: 10, currentTick: null });
    expect(rhcPositionSource.label(p!)).toBe("#3 · ticks -10 to 10");
  });

  it("close block reasons match the pools-page panel wording", () => {
    const native = (l: PositionLookup, held: ScannedPosition | null = null) => ({ lookup: l, held, priceRange: null });
    expect(rhcCloseBlockReason(native({ tokenId: "1", position: null, error: "rpc" }))).toBe("Could not read this position right now.");
    expect(rhcCloseBlockReason(native({ tokenId: "1", position: null, error: "not-found" }))).toBe("Closed (or never existed).");
    expect(rhcCloseBlockReason(native(lookup("1", { ownedByUser: false, owner: "0x1234567890abcdef1234567890abcdef12345678" })))).toBe("Owned by another wallet (0x1234…5678).");
    expect(rhcCloseBlockReason(native(lookup("1", { poolId: "0xdead" }), scanned("1"))))
      .toBe("StablePair pool that SoFinance does not list yet: view only.");
    expect(rhcCloseBlockReason(native(lookup("1", { poolId: "0xdead" }), { ...scanned("1"), stablePair: false })))
      .toBe("Another Uniswap v4 pool, not supported by SoFinance: view only.");
    expect(rhcCloseBlockReason(native(lookup("1", { poolId: "0xdead" })))).toBe("Not in a pool SoFinance supports.");
    expect(rhcCloseBlockReason(native(lookup("1")))).toBeNull();
  });
});

describe("capabilitiesFor(position): per-position override (PM requirement)", () => {
  const [closable, otherWallet, unknownPool] = rhcPositionSource.fromDiscovery({ scanned: [], lookups: [
    lookup("1"), lookup("2", { ownedByUser: false, owner: "0x1234567890abcdef1234567890abcdef12345678" }), lookup("3", { poolId: "0xdead" })] });

  it("defaults to the source capabilities (same object) when the position has no override", () => {
    expect(capabilitiesFor(rhcPositionSource, closable)).toBe(rhcPositionSource.capabilities);
    expect(capabilitiesFor(rhcPositionSource, null)).toBe(rhcPositionSource.capabilities);
  });

  it("one pool supports Withdraw, another does not: same tabs, only that position's Withdraw turns unavailable with its reason", () => {
    const a = capabilitiesFor(rhcPositionSource, closable);
    const b = capabilitiesFor(rhcPositionSource, unknownPool);
    expect(a.withdraw.supported).toBe(true);
    expect(toolUnavailableReason(b, "withdraw")).toBe("Not in a pool SoFinance supports.");
    expect(b.exitPreview.supported).toBe(false);
    // Everything else is untouched: the UI shape is identical.
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const key of ["compound", "performance", "deposit", "rangeDisplay", "manualAdd", "signer"] as const) expect(b[key]).toEqual(a[key]);
    expect(toolUnavailableReason(capabilitiesFor(rhcPositionSource, otherWallet), "withdraw")).toBe("Owned by another wallet (0x1234…5678).");
  });

  it("a custom source can turn a tool ON for one pool only", () => {
    const source = { ...rhcPositionSource, positionCapabilities: (p: typeof closable) => (p!.nativeId === "1" ? { compound: { supported: true as const } } : {}) };
    expect(capabilitiesFor(source, closable).compound.supported).toBe(true);
    expect(capabilitiesFor(source, unknownPool).compound.supported).toBe(false);
  });
});

describe("Robinhood Chain rows", () => {
  it("Closed (liquidity 0 or gone) rows go last and are labelled; otherwise the scan order is kept", () => {
    const list = rhcPositionSource.fromDiscovery({ scanned: [scanned("9", { liquidity: "0" }), scanned("8")], lookups: [{ tokenId: "4", position: null, error: "not-found" }, lookup("6")] });
    const [group] = groupPositions(list, { "robinhood-chain": ["rhc-uniswap-v4"] });
    expect(group!.positions.map((p) => p.nativeId)).toEqual(["8", "6", "9", "4"]);
    expect(group!.showSourceName).toBe(false);
    expect(positionOptionLabel(rhcPositionSource, group!.positions[2]!)).toMatch(/^#9 · .* · Closed$/);
    expect(positionOptionLabel(rhcPositionSource, group!.positions[3]!)).toBe("#4 · Closed");
    expect(positionOptionLabel(rhcPositionSource, group!.positions[0]!, { showSourceName: true })).toMatch(/^Uniswap v4 · #8/);
  });
});
