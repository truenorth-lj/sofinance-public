import { describe, expect, it } from "vitest";
import { WalletRequestError } from "@/lib/rhc-wallet/eip1193";
import {
  classifyWalletConnectError,
  detectConnectDevice,
  detectEvmWalletExtension,
  detectSolanaWalletExtension,
  phantomBrowseUrl,
  redactWalletConnectErrorMessage,
  solflareBrowseUrl,
  walletConnectContext,
} from "./wallet-connect";

describe("detectConnectDevice", () => {
  it("treats phones and official mobile UA hints as mobile, and desktop UA as desktop", () => {
    expect(detectConnectDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe("mobile");
    expect(detectConnectDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" })).toBe("mobile");
    expect(detectConnectDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0", uaMobile: false, maxTouchPoints: 0, coarsePointer: false })).toBe("desktop");
    expect(detectConnectDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", uaMobile: true })).toBe("mobile");
    expect(detectConnectDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", uaMobile: false, maxTouchPoints: 5, coarsePointer: true })).toBe("mobile");
  });
});

describe("wallet extension detection", () => {
  it("detects injected Solana and EVM wallets, and a Wallet Standard list", () => {
    expect(detectSolanaWalletExtension({ target: {} })).toBe(false);
    // Featured/adapter list length is not a detection signal (those lists are always populated).
    expect(detectSolanaWalletExtension({ target: {} })).toBe(false);
    expect(detectSolanaWalletExtension({ target: { phantom: { solana: {} } } })).toBe(true);
    expect(detectSolanaWalletExtension({ target: { solflare: {} } })).toBe(true);
    expect(detectSolanaWalletExtension({ target: { navigator: { wallets: [{}] } } })).toBe(true);
    expect(detectEvmWalletExtension({ target: {} })).toBe(false);
    expect(detectEvmWalletExtension({ target: { ethereum: {} } })).toBe(true);
  });
});

describe("classifyWalletConnectError", () => {
  it("maps rejections, missing wallets, timeouts, and everything else", () => {
    expect(classifyWalletConnectError(new WalletRequestError("rejected", "You rejected the request in your wallet."))).toBe("user_rejected");
    expect(classifyWalletConnectError(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe("user_rejected");
    expect(classifyWalletConnectError(new Error("User cancelled the request"))).toBe("user_rejected");
    expect(classifyWalletConnectError(new WalletRequestError("no-account", "No EVM wallet found. Install MetaMask to continue."))).toBe("not_installed");
    expect(classifyWalletConnectError(Object.assign(new Error("Phantom is not installed"), { name: "WalletNotFoundError" }))).toBe("not_installed");
    expect(classifyWalletConnectError(Object.assign(new Error("The request timed out"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyWalletConnectError(new Error("Wallet connection incomplete, please try again."))).toBe("other");
  });
});

describe("redactWalletConnectErrorMessage", () => {
  it("redacts base58 and hex addresses or signatures and truncates to about 120 characters", () => {
    const address = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const hex = "0x" + "ab".repeat(20);
    const message = redactWalletConnectErrorMessage(new Error(`Failed for ${address} and ${hex}`));
    expect(message).toBeDefined();
    expect(message!).not.toContain(address);
    expect(message!).not.toContain(hex);
    expect(message!).toMatch(/redacted-address|hex/i);
    const long = "failed to connect. ".repeat(20) + address;
    const truncated = redactWalletConnectErrorMessage(new Error(long))!;
    expect(truncated.length).toBeLessThanOrEqual(120);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).not.toContain(address);
  });
});

describe("deeplink URL building", () => {
  it("builds official Phantom and Solflare browse links with encoded page URL and origin", () => {
    const page = "https://sofinancelab.xyz/app/portfolio?ref=x-launch";
    const origin = "https://sofinancelab.xyz";
    expect(phantomBrowseUrl(page, origin)).toBe(
      `https://phantom.com/ul/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`,
    );
    expect(solflareBrowseUrl(page, origin)).toBe(
      `https://solflare.com/ul/v1/browse/${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`,
    );
  });
});

describe("walletConnectContext", () => {
  it("fills device and extension detection around the caller's chain and wallet name", () => {
    expect(walletConnectContext({
      wallet_name: "Phantom", chain: "solana", device: "desktop", wallet_extension_detected: true,
    })).toEqual({
      wallet_name: "Phantom", chain: "solana", device: "desktop", wallet_extension_detected: true,
    });
    expect(walletConnectContext({ chain: "rhc", device: "mobile", wallet_extension_detected: false }).wallet_name).toBeUndefined();
  });
});
