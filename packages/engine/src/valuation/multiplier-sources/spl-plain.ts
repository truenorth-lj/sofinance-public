import type { MultiplierSource } from "./types";

/** A Solana mint account read without a ScaledUiAmount extension (SPL, or Token-2022 without it): known to be 1. */
export const splPlainSource: MultiplierSource = {
  id: "spl-plain",
  read(ref, hints) {
    if (ref.chain !== "solana") return null;
    return hints.some((hint) => hint.kind === "mint-extensions" && hint.scaledUiConfig === null) ? { kind: "none" } : null;
  },
};
