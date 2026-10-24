import { describe, expect, it } from "vitest";
import {
  INPUT_ASSET_NOT_HELD_CODE,
  INPUT_ASSET_NOT_HELD_ENGINE_MESSAGE,
  INPUT_ASSET_NOT_HELD_MESSAGE,
  isInputAssetNotHeldError,
} from "./selected-input-asset-not-held";

describe("isInputAssetNotHeldError", () => {
  it("matches the engine's exact zero-balance token-input message", () => {
    expect(isInputAssetNotHeldError(new Error(INPUT_ASSET_NOT_HELD_ENGINE_MESSAGE))).toBe(true);
    expect(INPUT_ASSET_NOT_HELD_CODE).toBe("input_asset_not_held");
    expect(INPUT_ASSET_NOT_HELD_MESSAGE).toMatch(/pick another asset/i);
  });

  it("does not treat sibling mint/frozen reasons or punctuation variants as this case", () => {
    expect(isInputAssetNotHeldError(new Error(`${INPUT_ASSET_NOT_HELD_ENGINE_MESSAGE}.`))).toBe(false);
    expect(isInputAssetNotHeldError(new Error("Input asset ATA is frozen"))).toBe(false);
    expect(isInputAssetNotHeldError(new Error("NFT cannot be used as input asset"))).toBe(false);
    expect(isInputAssetNotHeldError(new Error("Wallet does not currently hold this Raydium CLMM position NFT"))).toBe(false);
    expect(isInputAssetNotHeldError("Wallet does not have the selected investable asset")).toBe(false);
  });
});
