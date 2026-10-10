import { describe, it, expect, beforeAll } from "vitest";
import {
  generateMcpToken,
  verifyMcpToken,
  extractWalletFromToken,
  isTokenExpiringSoon,
  generateChallenge,
  createChallengeMessage,
  verifyChallengeSignature,
  consumeChallengeNonce,
  clearUsedChallengeNonces,
  parseChallengeNonce,
} from "./mcp-auth";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

describe("MCP Auth", () => {
  const testKeypair = Keypair.generate();
  const testWallet = testKeypair.publicKey.toBase58();
  const testSecret = "test-secret-key";

  describe("generateMcpToken", () => {
    it("should generate a valid token", () => {
      const token = generateMcpToken(testWallet, testSecret);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(2);
    });

    it("should throw on missing wallet", () => {
      expect(() => generateMcpToken("", testSecret)).toThrow();
    });

    it("should throw on missing secret", () => {
      expect(() => generateMcpToken(testWallet, "")).toThrow();
    });

    it("should generate different tokens on subsequent calls", () => {
      const token1 = generateMcpToken(testWallet, testSecret);
      const token2 = generateMcpToken(testWallet, testSecret);
      expect(token1).not.toBe(token2); // Different nonces
    });
  });

  describe("verifyMcpToken", () => {
    let validToken: string;

    beforeAll(() => {
      validToken = generateMcpToken(testWallet, testSecret);
    });

    it("should verify a valid token", () => {
      const payload = verifyMcpToken(validToken, testSecret);
      expect(payload).toBeTruthy();
      expect(payload?.wallet).toBe(testWallet);
      expect(payload?.version).toBe("v1");
    });

    it("should reject tampered token", () => {
      const parts = validToken.split(".");
      const tamperedToken = parts[0] + ".invalid-signature";
      const payload = verifyMcpToken(tamperedToken, testSecret);
      expect(payload).toBeNull();
    });

    it("should reject token with wrong secret", () => {
      const payload = verifyMcpToken(validToken, "wrong-secret");
      expect(payload).toBeNull();
    });

    it("should reject expired token", () => {
      const expiredToken = generateMcpToken(testWallet, testSecret, -1000); // Already expired
      const payload = verifyMcpToken(expiredToken, testSecret);
      expect(payload).toBeNull();
    });

    it("should reject invalid format", () => {
      expect(verifyMcpToken("invalid", testSecret)).toBeNull();
      expect(verifyMcpToken("", testSecret)).toBeNull();
      expect(verifyMcpToken("a.b.c", testSecret)).toBeNull();
    });
  });

  describe("extractWalletFromToken", () => {
    it("should extract wallet address from valid token", () => {
      const token = generateMcpToken(testWallet, testSecret);
      const wallet = extractWalletFromToken(token, testSecret);
      expect(wallet).toBe(testWallet);
    });

    it("should return null for invalid token", () => {
      const wallet = extractWalletFromToken("invalid", testSecret);
      expect(wallet).toBeNull();
    });
  });

  describe("isTokenExpiringSoon", () => {
    it("should detect soon-to-expire tokens", () => {
      const token = generateMcpToken(testWallet, testSecret, 30 * 60 * 1000); // 30 minutes
      const expiringSoon = isTokenExpiringSoon(token, testSecret, 60 * 60 * 1000); // 1 hour threshold
      expect(expiringSoon).toBe(true);
    });

    it("should not flag tokens with plenty of time", () => {
      const token = generateMcpToken(testWallet, testSecret, 24 * 60 * 60 * 1000); // 24 hours
      const expiringSoon = isTokenExpiringSoon(token, testSecret, 60 * 60 * 1000); // 1 hour threshold
      expect(expiringSoon).toBe(false);
    });

    it("should treat invalid tokens as expiring", () => {
      const expiringSoon = isTokenExpiringSoon("invalid", testSecret);
      expect(expiringSoon).toBe(true);
    });
  });

  describe("Token payload", () => {
    it("should contain all required fields", () => {
      const token = generateMcpToken(testWallet, testSecret);
      const payload = verifyMcpToken(token, testSecret);

      expect(payload).toBeTruthy();
      expect(payload?.version).toBe("v1");
      expect(payload?.wallet).toBe(testWallet);
      expect(payload?.issuedAt).toBeLessThanOrEqual(Date.now());
      expect(payload?.expiresAt).toBeGreaterThan(Date.now());
      expect(payload?.nonce).toBeTruthy();
      expect(typeof payload?.nonce).toBe("string");
    });
  });

  describe("Challenge generation", () => {
    it("should generate a valid challenge", () => {
      const challenge = generateChallenge(testWallet);

      expect(challenge.wallet).toBe(testWallet);
      expect(challenge.message).toBeTruthy();
      expect(challenge.issuedAt).toBeLessThanOrEqual(Date.now());
      expect(challenge.nonce).toBeTruthy();
      expect(typeof challenge.nonce).toBe("string");
    });

    it("should include wallet in challenge message", () => {
      const challenge = generateChallenge(testWallet);
      expect(challenge.message).toContain(testWallet);
      expect(challenge.message).toContain("SoFinance MCP token");
    });

    it("should throw on invalid wallet", () => {
      expect(() => generateChallenge("invalid-wallet")).toThrow();
    });

    it("should generate different nonces", () => {
      const challenge1 = generateChallenge(testWallet);
      const challenge2 = generateChallenge(testWallet);
      expect(challenge1.nonce).not.toBe(challenge2.nonce);
    });
  });

  describe("Challenge message creation", () => {
    it("should create correct format", () => {
      const issuedAt = Date.now();
      const nonce = "test-nonce";
      const message = createChallengeMessage(testWallet, issuedAt, nonce);

      expect(message).toContain("SoFinance MCP token");
      expect(message).toContain(`wallet:${testWallet}`);
      expect(message).toContain(`issuedAt:${issuedAt}`);
      expect(message).toContain(`nonce:${nonce}`);
    });
  });

  describe("Challenge signature verification", () => {
    it("should verify valid signature", () => {
      const challenge = generateChallenge(testWallet);
      const messageBytes = new TextEncoder().encode(challenge.message);
      const signature = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureBase58 = bs58.encode(signature);

      const valid = verifyChallengeSignature(testWallet, challenge.message, signatureBase58);
      expect(valid).toBe(true);
    });

    it("should reject invalid signature", () => {
      const challenge = generateChallenge(testWallet);
      const invalidSignature = bs58.encode(new Uint8Array(64).fill(0));

      const valid = verifyChallengeSignature(testWallet, challenge.message, invalidSignature);
      expect(valid).toBe(false);
    });

    it("should reject signature from wrong wallet", () => {
      const challenge = generateChallenge(testWallet);
      const wrongKeypair = Keypair.generate();
      const messageBytes = new TextEncoder().encode(challenge.message);
      const signature = nacl.sign.detached(messageBytes, wrongKeypair.secretKey);
      const signatureBase58 = bs58.encode(signature);

      const valid = verifyChallengeSignature(testWallet, challenge.message, signatureBase58);
      expect(valid).toBe(false);
    });

    it("should reject stale challenge", () => {
      const staleIssuedAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const nonce = "test-nonce";
      const message = createChallengeMessage(testWallet, staleIssuedAt, nonce);
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureBase58 = bs58.encode(signature);

      const valid = verifyChallengeSignature(testWallet, message, signatureBase58);
      expect(valid).toBe(false);
    });

    it("should reject tampered message", () => {
      const challenge = generateChallenge(testWallet);
      const messageBytes = new TextEncoder().encode(challenge.message);
      const signature = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureBase58 = bs58.encode(signature);

      const tamperedMessage = challenge.message.replace(testWallet, "different-wallet");
      const valid = verifyChallengeSignature(testWallet, tamperedMessage, signatureBase58);
      expect(valid).toBe(false);
    });

    it("consumes a nonce only once", () => {
      clearUsedChallengeNonces();
      const challenge = generateChallenge(testWallet);
      const nonce = parseChallengeNonce(challenge.message);
      expect(nonce).toBeTruthy();
      expect(consumeChallengeNonce(testWallet, nonce!)).toBe(true);
      expect(consumeChallengeNonce(testWallet, nonce!)).toBe(false);
    });

    it("should handle malformed messages", () => {
      const messageBytes = new TextEncoder().encode("invalid message format");
      const signature = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureBase58 = bs58.encode(signature);

      const valid = verifyChallengeSignature(testWallet, "invalid message format", signatureBase58);
      expect(valid).toBe(false);
    });
  });
});
