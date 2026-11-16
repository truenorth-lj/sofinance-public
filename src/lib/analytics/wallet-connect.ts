import { sanitizeOpenErrorMessage } from "./errors";

export type WalletConnectChain = "solana" | "rhc";
export type WalletConnectDevice = "mobile" | "desktop";
export type WalletConnectErrorType = "user_rejected" | "not_installed" | "timeout" | "other";

export type WalletConnectContext = {
  wallet_name?: string;
  chain: WalletConnectChain;
  device: WalletConnectDevice;
  wallet_extension_detected: boolean;
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i;
const USER_REJECTED_CODES = new Set([4001, 5000]);

/** Official Phantom browse deeplink host (docs.phantom.com: use phantom.com, not phantom.app). */
export const PHANTOM_BROWSE_HOST = "https://phantom.com";
/** Official Solflare browse deeplink (docs.solflare.com/solflare/technical/deeplinks/other-methods/browse). */
export const SOLFLARE_BROWSE_HOST = "https://solflare.com";

export function detectConnectDevice(options?: {
  userAgent?: string;
  uaMobile?: boolean;
  maxTouchPoints?: number;
  coarsePointer?: boolean;
}): WalletConnectDevice {
  const ua = options?.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const uaMobile = options?.uaMobile ?? (typeof navigator === "undefined" ? undefined
    : (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile);
  if (uaMobile === true) return "mobile";
  if (MOBILE_UA.test(ua)) return "mobile";
  const touch = options?.maxTouchPoints ?? (typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0);
  const coarse = options?.coarsePointer ?? (typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches : false);
  if (touch > 1 && coarse) return "mobile";
  return "desktop";
}

export function detectSolanaWalletExtension(options?: {
  target?: { solana?: unknown; phantom?: { solana?: unknown }; solflare?: unknown; backpack?: unknown; glow?: unknown; navigator?: { wallets?: unknown } };
}): boolean {
  const target = options?.target ?? (typeof window === "undefined" ? undefined : window as unknown as NonNullable<typeof options>["target"]);
  if (!target) return false;
  if (target.solana || target.phantom?.solana || target.solflare || target.backpack || target.glow) return true;
  const wallets = target.navigator?.wallets ?? (typeof navigator === "undefined" ? undefined : (navigator as Navigator & { wallets?: unknown }).wallets);
  return Array.isArray(wallets) && wallets.length > 0;
}

export function detectEvmWalletExtension(options?: { target?: { ethereum?: unknown } }): boolean {
  const target = options?.target ?? (typeof window === "undefined" ? undefined : window as unknown as { ethereum?: unknown });
  return Boolean(target?.ethereum);
}

export function walletConnectContext(partial: {
  wallet_name?: string;
  chain: WalletConnectChain;
  device?: WalletConnectDevice;
  wallet_extension_detected?: boolean;
}): WalletConnectContext {
  const device = partial.device ?? detectConnectDevice();
  const wallet_extension_detected = partial.wallet_extension_detected ?? (
    partial.chain === "rhc" ? detectEvmWalletExtension() : detectSolanaWalletExtension()
  );
  const context: WalletConnectContext = { chain: partial.chain, device, wallet_extension_detected };
  if (partial.wallet_name) context.wallet_name = partial.wallet_name;
  return context;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function errorCode(error: unknown): number | string | undefined {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
    current = (current as { error?: unknown; cause?: unknown }).error ?? (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyWalletConnectError(error: unknown): WalletConnectErrorType {
  const code = errorCode(error);
  if (code === "rejected" || (typeof code === "number" && USER_REJECTED_CODES.has(code))) return "user_rejected";
  const message = errorText(error).toLowerCase();
  const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name : "";
  if (/user rejected|rejected the request|rejected by user|cancelled|canceled|denied/.test(message)) return "user_rejected";
  if (code === "no-account" || /not installed|wallet not found|no (?:evm )?wallet found|no provider|walletnotfound|walletnotready|is not defined|install (?:metamask|phantom|solflare)/i.test(message)
    || /WalletNotFoundError|WalletNotReadyError|WalletNotSelectedError/.test(name)) return "not_installed";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|timeout|aborted/.test(message)) return "timeout";
  return "other";
}

/** First ~120 characters, with base58/hex addresses and signatures redacted (same scrubber as open_position_failed). */
export function redactWalletConnectErrorMessage(error: unknown): string | undefined {
  return sanitizeOpenErrorMessage(error);
}

export function phantomBrowseUrl(pageUrl: string, origin: string): string {
  return `${PHANTOM_BROWSE_HOST}/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
}

export function solflareBrowseUrl(pageUrl: string, origin: string): string {
  return `${SOLFLARE_BROWSE_HOST}/ul/v1/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(origin)}`;
}

export function currentBrowseTarget(): { pageUrl: string; origin: string } | null {
  if (typeof window === "undefined") return null;
  return { pageUrl: window.location.href, origin: window.location.origin };
}
