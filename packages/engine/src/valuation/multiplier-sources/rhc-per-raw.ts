import type { MultiplierSource } from "./types";

/**
 * Robinhood Chain: stored prices are per raw unit, so valuation never applies the ERC-20 `uiMultiplier()` (PM decision
 * Q2, 2026-11-21). Known as 1 for valuation; no contract read.
 */
export const rhcPerRawSource: MultiplierSource = {
  id: "rhc-per-raw",
  read(ref) {
    return ref.chain === "robinhood" ? { kind: "none" } : null;
  },
};
