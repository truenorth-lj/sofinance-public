import { describe, expect, it } from "vitest";
import { ALLOWED_SWAP_PROGRAM_IDS, assertAllowedSwapPrograms } from "./jupiter";

const ix = (programId: string) => ({ programId, accounts: [], data: "" });
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

describe("swap-instruction program allowlist", () => {
  it("accepts Jupiter, token, ATA, compute-budget and system programs", () => {
    expect(() => assertAllowedSwapPrograms({
      computeBudgetInstructions: [ix("ComputeBudget111111111111111111111111111111")],
      setupInstructions: [ix("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), ix("11111111111111111111111111111111"), ix("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")],
      swapInstruction: ix(JUP), cleanupInstruction: ix("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), otherInstructions: [],
    })).not.toThrow();
    expect(ALLOWED_SWAP_PROGRAM_IDS.has("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")).toBe(true);
  });

  it.each([
    ["swap", { swapInstruction: ix("BadProgram1111111111111111111111111111111111") }],
    ["setup", { setupInstructions: [ix("BadProgram1111111111111111111111111111111111")] }],
    ["other", { otherInstructions: [ix("BadProgram1111111111111111111111111111111111")] }],
    ["cleanup", { cleanupInstruction: ix("BadProgram1111111111111111111111111111111111") }],
  ])("rejects an unknown program in the %s instruction", (_name, override) => {
    expect(() => assertAllowedSwapPrograms({ setupInstructions: [], swapInstruction: ix(JUP), cleanupInstruction: null,
      otherInstructions: [], ...override } as never)).toThrow(/allowlist/);
  });
});
