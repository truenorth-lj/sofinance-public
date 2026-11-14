import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import { RAYDIUM_CLMM_PROGRAM_ID } from "./ids";

describe("Raydium CLMM program id", () => {
  it("matches the Raydium SDK constant", () => {
    expect(RAYDIUM_CLMM_PROGRAM_ID.equals(CLMM_PROGRAM_ID)).toBe(true);
  });
});
