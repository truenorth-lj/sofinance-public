import { createHmac, randomBytes } from "crypto";

/**
 * MCP Authentication Token System
 * 
 * Generates short-lived tokens bound to a wallet address for remote MCP access.
 * Tokens authorize read/prepare/submit operations without exposing RPC/Jupiter keys locally.
 * 
 * Security:
 * - Tokens expire (default 24h, configurable)
 * - HMAC-signed with JUPITER_API_KEY (server-side secret)
 * - Bound to specific wallet address
 * - Can be revoked by changing secret or waiting for expiry
 */

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface McpTokenPayload {
  version: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/**
 * Generate a short-lived MCP auth token for a wallet.
 * 
 * @param wallet - Solana wallet public key (base58)
 * @param secret - HMAC secret (use JUPITER_API_KEY from env)
 * @param ttlMs - Token time-to-live in milliseconds (default 24h)
 * @returns Signed token string
 */
export function generateMcpToken(
  wallet: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  if (!wallet || !secret) {
    throw new Error("Wallet and secret are required");
  }

  const now = Date.now();
  const payload: McpTokenPayload = {
    version: TOKEN_VERSION,
    wallet,
    issuedAt: now,
    expiresAt: now + ttlMs,
    nonce: randomBytes(16).toString("hex"),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson).toString("base64url");
  
  const signature = createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${signature}`;
}

/**
 * Verify and decode an MCP auth token.
 * 
 * @param token - Token string to verify
 * @param secret - HMAC secret (use JUPITER_API_KEY from env)
 * @returns Decoded payload if valid, null otherwise
 */
export function verifyMcpToken(
  token: string,
  secret: string
): McpTokenPayload | null {
  if (!token || !secret) {
    return null;
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }

    const [payloadBase64, signature] = parts;
    if (!payloadBase64 || !signature) {
      return null;
    }

    const expectedSignature = createHmac("sha256", secret)
      .update(payloadBase64)
      .digest("base64url");

    if (signature !== expectedSignature) {
      return null;
    }

    const payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as McpTokenPayload;

    if (payload.version !== TOKEN_VERSION) {
      return null;
    }

    if (Date.now() >= payload.expiresAt) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract wallet address from a verified token.
 * 
 * @param token - Token string
 * @param secret - HMAC secret
 * @returns Wallet address if valid, null otherwise
 */
export function extractWalletFromToken(
  token: string,
  secret: string
): string | null {
  const payload = verifyMcpToken(token, secret);
  return payload?.wallet ?? null;
}

/**
 * Check if a token will expire soon.
 * 
 * @param token - Token string
 * @param secret - HMAC secret
 * @param thresholdMs - Threshold in milliseconds (default 1 hour)
 * @returns True if token expires within threshold
 */
export function isTokenExpiringSoon(
  token: string,
  secret: string,
  thresholdMs: number = 60 * 60 * 1000
): boolean {
  const payload = verifyMcpToken(token, secret);
  if (!payload) {
    return true;
  }

  return Date.now() + thresholdMs >= payload.expiresAt;
}
