// @vitest-environment happy-dom
// Add-to-position input picker: no Token-2022 tag; ineligible assets stay blocked with their reason.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletAsset } from "@sofinance/engine/wallet-discovery";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TokenPicker } from "./token-picker";

const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
const asset = (mint: string, over: Partial<WalletAsset> = {}): WalletAsset => ({
  kind: "token", mint, tokenProgram: T22, decimals: 8, balance: "100000000", totalBalance: "100000000", account: `${mint}-ata`,
  eligible: true, reason: null, ...over } as WalletAsset);
const metadata = {
  SpcxMint1111111111111111111111111111111111: { symbol: "SPCX", name: "SpaceX Backpack", icon: null, isVerified: true, decimals: 8, tokenProgram: T22 },
  Blocked111111111111111111111111111111111111: { symbol: "BLK", name: "Blocked token", icon: null, isVerified: false, decimals: 8, tokenProgram: T22 },
  UsdcMint1111111111111111111111111111111111: { symbol: "USDC", name: "USD Coin", icon: null, isVerified: true, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58() },
} as never;

let root: Root; let container: HTMLDivElement;
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
});
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("TokenPicker (add to position)", () => {
  it("shows no Token-2022 tag on Token-2022 assets and still blocks ineligible assets with their reason", async () => {
    const onSelect = vi.fn();
    const assets = [
      asset("SpcxMint1111111111111111111111111111111111"),
      asset("UsdcMint1111111111111111111111111111111111", { tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: 6 }),
      asset("Blocked111111111111111111111111111111111111", { eligible: false, reason: "Transfer fee charged" }),
    ];
    await act(async () => root.render(createElement(TokenPicker, { assets, selectedAsset: undefined, metadata, disabled: false, onSelect })));
    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")!.click());
    const dialog = container.querySelector("dialog")!;
    expect(dialog.textContent).toContain("SPCX");
    expect(dialog.textContent).not.toContain("Token-2022");
    expect(dialog.textContent).toContain("Not available for deposit · 1");
    expect(dialog.textContent).toContain("Transfer fee charged");
    const blocked = [...dialog.querySelectorAll("[aria-disabled=true]")];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.textContent).toContain("BLK");
    expect(blocked[0]!.closest("button")).toBeNull();
    await act(async () => [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes("SPCX"))!.click());
    expect(onSelect).toHaveBeenCalledWith("token", "SpcxMint1111111111111111111111111111111111");
  });
});
