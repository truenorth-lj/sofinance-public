import { createHmac, randomBytes } from "crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * MCP Authentication Token System
 * 
 * Generates short-lived tokens bound to a wallet address for remote MCP access.
 * Tokens authorize read/prepare/submit operations without exposing RPC/Jupiter keys locally.
 * 
 * Security:
 * - Requires ed25519 signature proof of wallet ownership before minting
 * - Tokens expire (default 24h, configurable)
 * - HMAC-signed with JUPITER_API_KEY (server-side secret)
 * - Bound to specific wallet address
 * - Can be revoked by changing secret or waiting for expiry
 */

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHALLENGE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export interface McpTokenPayload {
  version: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface TokenChallenge {
  wallet: string;
  issuedAt: number;
  nonce: string;
}

/**
 * Create a deterministic challenge message for wallet to sign.
 * This proves wallet ownership before minting a token.
 * 
 * @param wallet - Solana wallet public key (base58)
 * @param issuedAt - Unix timestamp in milliseconds
 * @param nonce - Random hex string
 * @returns Message to sign
 */
export function createChallengeMessage(
  wallet: string,
  issuedAt: number,
  nonce: string
): string {
  return `SoFinance MCP token\nwallet:${wallet}\nissuedAt:${issuedAt}\nnonce:${nonce}`;
}

/**
 * Generate a challenge for the wallet to sign.
 * Client must sign this message and return signature + message to prove ownership.
 * 
 * @param wallet - Solana wallet public key (base58)
 * @returns Challenge object with message
 */
export function generateChallenge(wallet: string): {
  wallet: string;
  message: string;
  issuedAt: number;
  nonce: string;
} {
  if (!wallet) {
    throw new Error("Wallet is required");
  }

  // Validate wallet format
  try {
    new PublicKey(wallet);
  } catch {
    throw new Error("Invalid wallet address");
  }

  const issuedAt = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const message = createChallengeMessage(wallet, issuedAt, nonce);

  return { wallet, message, issuedAt, nonce };
}

/**
 * Verify a wallet signature over a challenge message.
 * 
 * @param wallet - Claimed wallet public key (base58)
 * @param message - Challenge message that was signed
 * @param signature - Base58-encoded ed25519 signature
 * @returns True if signature is valid and fresh
 */
export function verifyChallengeSignature(
  wallet: string,
  message: string,
  signature: string
): boolean {
  try {
    // Validate wallet
    const publicKey = new PublicKey(wallet);
    
    // Decode signature
    const signatureBytes = bs58.decode(signature);
    
    // Verify signature
    const messageBytes = new TextEncoder().encode(message);
    const publicKeyBytes = publicKey.toBytes();
    
    const valid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );

    if (!valid) {
      return false;
    }

    // Parse and validate message freshness
    const lines = message.split("\n");
    if (lines.length !== 4 || lines[0] !== "SoFinance MCP token") {
      return false;
    }

    const walletLine = lines[1];
    const issuedAtLine = lines[2];

    if (!walletLine?.startsWith("wallet:") || !issuedAtLine?.startsWith("issuedAt:")) {
      return false;
    }

    const messageWallet = walletLine.slice(7);
    const issuedAtStr = issuedAtLine.slice(9);

    if (messageWallet !== wallet) {
      return false;
    }

    const issuedAt = parseInt(issuedAtStr, 10);
    if (!Number.isSafeInteger(issuedAt)) {
      return false;
    }

    // Check freshness (allow 5 minute skew)
    const now = Date.now();
    if (Math.abs(now - issuedAt) > CHALLENGE_SKEW_MS) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a short-lived MCP auth token for a wallet AFTER signature verification.
 * 
 * SECURITY: This should only be called after verifying wallet ownership via signature.
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

  // Validate wallet format
  try {
    new PublicKey(wallet);
  } catch {
    throw new Error("Invalid wallet address");
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
