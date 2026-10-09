import { describe, expect, it } from "vitest";
import {
  createWalletField,
  editWalletField,
  initialWalletField,
  parseListedPositions,
  parsePerformanceQuery,
  resetWalletFieldToConnected,
  resolveWalletField,
  showUseConnectedWallet,
  syncWalletField,
} from "./position-performance-form";

const connected = "11111111111111111111111111111111";
const other = "22222222222222222222222222222222";

describe("parsePerformanceQuery", () => {
  it("reads mint and wallet, preferring mint over positionMint", () => {
    expect(parsePerformanceQuery({ mint: " mintA ", wallet: " walletA " })).toEqual({
      mint: "mintA",
      wallet: "walletA",
    });
    expect(parsePerformanceQuery({ positionMint: "fromAlias", wallet: other })).toEqual({
      mint: "fromAlias",
      wallet: other,
    });
    expect(parsePerformanceQuery({ mint: "explicit", positionMint: "alias", wallet: connected })).toEqual({
      mint: "explicit",
      wallet: connected,
    });
  });

  it("treats missing or blank query values as empty", () => {
    expect(parsePerformanceQuery({})).toEqual({ mint: "", wallet: "" });
    expect(parsePerformanceQuery({ mint: "  ", wallet: "" })).toEqual({ mint: "", wallet: "" });
    expect(parsePerformanceQuery({ mint: [" first ", "second"], wallet: [" w "] })).toEqual({
      mint: "first",
      wallet: "w",
    });
  });
});

describe("wallet field sync", () => {
  it("defaults to the connected wallet unless a URL wallet takes precedence", () => {
    expect(initialWalletField("", connected)).toEqual({ value: connected, intent: "auto" });
    expect(initialWalletField(other, connected)).toEqual({ value: other, intent: "url" });
    expect(initialWalletField("", undefined)).toEqual({ value: "", intent: "auto" });
  });

  it("fills when a wallet connects later and clears an auto-filled value on disconnect", () => {
    const empty = createWalletField("");
    const filled = syncWalletField(empty, connected);
    expect(filled).toEqual({ value: connected, intent: "auto" });
    expect(syncWalletField(filled, undefined)).toEqual({ value: "", intent: "auto" });
  });

  it("does not overwrite a manual or URL value when wallet state changes", () => {
    const typed = editWalletField(other);
    expect(syncWalletField(typed, connected)).toEqual(typed);
    expect(syncWalletField(typed, undefined)).toEqual(typed);

    const fromUrl = createWalletField(other);
    expect(syncWalletField(fromUrl, connected)).toEqual(fromUrl);
    expect(syncWalletField(fromUrl, undefined)).toEqual(fromUrl);
  });

  it("lets Use connected wallet reset tracking back to auto", () => {
    const reset = resetWalletFieldToConnected(connected);
    expect(reset).toEqual({ value: connected, intent: "auto" });
    expect(syncWalletField(reset, undefined)).toEqual({ value: "", intent: "auto" });
  });

  it("resolves URL, manual edits, and the connected wallet without overwriting", () => {
    expect(
      resolveWalletField({
        urlWallet: "",
        connectedAddress: connected,
        manualValue: null,
        ignoreUrl: false,
      }),
    ).toEqual({ value: connected, intent: "auto" });

    expect(
      resolveWalletField({
        urlWallet: other,
        connectedAddress: connected,
        manualValue: null,
        ignoreUrl: false,
      }),
    ).toEqual({ value: other, intent: "url" });

    expect(
      resolveWalletField({
        urlWallet: other,
        connectedAddress: connected,
        manualValue: "",
        ignoreUrl: false,
      }),
    ).toEqual({ value: "", intent: "manual" });

    expect(
      resolveWalletField({
        urlWallet: other,
        connectedAddress: connected,
        manualValue: null,
        ignoreUrl: true,
      }),
    ).toEqual({ value: connected, intent: "auto" });

    expect(
      resolveWalletField({
        urlWallet: "",
        connectedAddress: undefined,
        manualValue: null,
        ignoreUrl: true,
      }),
    ).toEqual({ value: "", intent: "auto" });
  });

  it("shows the reset affordance only while the field differs from the connected wallet", () => {
    expect(showUseConnectedWallet(connected, connected)).toBe(false);
    expect(showUseConnectedWallet(` ${connected} `, connected)).toBe(false);
    expect(showUseConnectedWallet(other, connected)).toBe(true);
    expect(showUseConnectedWallet("", connected)).toBe(true);
    expect(showUseConnectedWallet(other, undefined)).toBe(false);
  });
});

describe("parseListedPositions", () => {
  it("keeps well-formed position rows and drops junk", () => {
    expect(
      parseListedPositions({
        positions: [
          {
            positionMint: other,
            mintA: connected,
            mintB: other,
            tickLower: -10,
            tickUpper: 10,
            rangeSide: "inside",
          },
          { positionMint: "" },
          { notAPosition: true },
          null,
        ],
      }),
    ).toEqual([
      {
        positionMint: other,
        mintA: connected,
        mintB: other,
        tickLower: -10,
        tickUpper: 10,
        rangeSide: "inside",
      },
    ]);
    expect(parseListedPositions({ error: "nope" })).toEqual([]);
    expect(parseListedPositions(null)).toEqual([]);
  });
});
