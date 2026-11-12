import { describe, expect, it } from "vitest";
import { dexDescriptors } from "@/lib/dex/client";
import { resolveOpenDispatch, type OpenHandler, type OpenDispatchDeps, type PoolOpenRef } from "./open-dispatch";

const UNSUPPORTED_REASON = "This token uses a balance multiplier, which we don't support yet.";
const ORCA_NONE = "Opening is not available yet";
const METEORA_UNSUPPORTED_REASON = "Opening needs a newer pool version.";

const protocols = [
  { protocol: "raydium-clmm", chain: "solana" },
  { protocol: "orca-whirlpool", chain: "solana" },
  { protocol: "meteora-dlmm", chain: "solana" },
  { protocol: "uniswap-v4-rhc", chain: "robinhood" },
] as const;

const pool = (protocol: string, chain: string, over: Partial<PoolOpenRef> = {}): PoolOpenRef => ({ protocol, chain, ...over });

const same = (handler: OpenHandler): { button: OpenHandler; deepLink: OpenHandler } => ({ button: handler, deepLink: handler });

const meteoraOpenUnsupported: OpenDispatchDeps = {
  descriptorFor: (id) => {
    const descriptor = dexDescriptors.descriptorFor(id);
    if (!descriptor) return null;
    return { ...descriptor, capabilities: { ...descriptor.capabilities, open: { supported: false, reason: METEORA_UNSUPPORTED_REASON } } };
  },
};

/** Locked against current main (E-T merge) before the openUi rewire; every cell must stay identical after it. */
describe("open dispatch handler matrix (button and deep link)", () => {
  it.each(protocols)("$protocol + unsupported token: both entry points use the unsupported handler", ({ protocol, chain }) => {
    expect(resolveOpenDispatch(pool(protocol, chain, { unsupportedIssues: ["ScaledUiAmount multiplier not 1"] }))).toEqual(
      same({ handler: "unsupported", reason: UNSUPPORTED_REASON }),
    );
  });

  it("Raydium native modal: button and deep link call the same handler", () => {
    expect(resolveOpenDispatch(pool("raydium-clmm", "solana"))).toEqual(same({ handler: "native-modal" }));
  });

  it("RHC dialog (canonical id): button and deep link call the same handler", () => {
    expect(resolveOpenDispatch(pool("uniswap-v4-rhc", "robinhood"))).toEqual(same({ handler: "rhc-dialog" }));
  });

  it("the retired rhc-uniswap-v4 spelling no longer opens the RHC dialog", () => {
    expect(resolveOpenDispatch(pool("rhc-uniswap-v4", "robinhood"))).toEqual(
      same({ handler: "none", reason: "Opening is not available yet" }),
    );
  });

  it("Orca is not available yet: button and deep link call the same handler", () => {
    expect(resolveOpenDispatch(pool("orca-whirlpool", "solana"))).toEqual(
      same({ handler: "none", reason: ORCA_NONE }),
    );
  });

  it("Meteora open supported: button and deep link both open the registry dialog", () => {
    expect(resolveOpenDispatch(pool("meteora-dlmm", "solana"))).toEqual(same({ handler: "registry" }));
  });

  it("Meteora open unsupported: button and deep link both stay closed with the capability reason", () => {
    expect(resolveOpenDispatch(pool("meteora-dlmm", "solana"), meteoraOpenUnsupported)).toEqual(
      same({ handler: "none", reason: METEORA_UNSUPPORTED_REASON }),
    );
  });
});
