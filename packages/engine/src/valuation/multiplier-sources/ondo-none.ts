import type { MultiplierSource } from "./types";

/** Ondo Global Markets tokens carry no share multiplier. The issuer comes from the token registry, passed as a hint. */
export const ondoNoneSource: MultiplierSource = {
  id: "ondo-none",
  read(_ref, hints) {
    return hints.some((hint) => hint.kind === "issuer" && hint.issuer === "ondo") ? { kind: "none" } : null;
  },
};
