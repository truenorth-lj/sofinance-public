import { describe, expect, it } from "vitest";
import { resolveNftAccountLookup } from "./exit-account-lookup";

const MINT = "PositionMint111111111111111111111111111111";
const base = { connected: true, targetMint: MINT, discovery: null, state: null, loadingDiscovery: false, loadingState: false, hasError: false };
const held = { positions: [{ positionMint: MINT }], assets: [{ eligible: true }] };
const ready = { positionMint: MINT, nftAta: "Ata1", ownsNft: true };

describe("resolveNftAccountLookup", () => {
  it("returns the wallet's NFT account once the matching state is loaded", () => {
    expect(resolveNftAccountLookup({ ...base, discovery: held, state: ready })).toEqual({ account: "Ata1", pending: false });
  });
  it("does not use a state that belongs to another position, or one the wallet does not actually hold", () => {
    expect(resolveNftAccountLookup({ ...base, discovery: held, state: { ...ready, positionMint: "Other" }, loadingState: true }).account).toBeUndefined();
    expect(resolveNftAccountLookup({ ...base, discovery: held, state: { ...ready, ownsNft: false } })).toEqual({ account: undefined, pending: false });
  });
  it("is pending only while discovery or the selected state is genuinely still loading", () => {
    expect(resolveNftAccountLookup({ ...base, loadingDiscovery: true })).toEqual({ account: undefined, pending: true });
    expect(resolveNftAccountLookup({ ...base, discovery: held, loadingState: true })).toEqual({ account: undefined, pending: true });
    expect(resolveNftAccountLookup({ ...base, discovery: held })).toEqual({ account: undefined, pending: true });
  });
  it.each([
    ["no wallet connected", { connected: false }],
    ["a read failed", { hasError: true, discovery: held }],
    ["the wallet holds no positions", { discovery: { positions: [], assets: [{ eligible: true }] } }],
    ["the wallet holds only other positions (deep link to a foreign position)", { discovery: { positions: [{ positionMint: "Other" }], assets: [{ eligible: true }] } }],
    ["the wallet has no investable asset, so no selection or state can ever form", { discovery: { positions: [{ positionMint: MINT }], assets: [{ eligible: false }] } }],
    ["there is no target position", { targetMint: "" }],
  ])("is terminal (never pending) when %s", (_name, patch) => {
    expect(resolveNftAccountLookup({ ...base, ...patch })).toEqual({ account: undefined, pending: false });
  });
});
