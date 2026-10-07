import { describe, it, expect, beforeAll } from "vitest";
import { generateMcpToken, verifyMcpToken, extractWalletFromToken, isTokenExpiringSoon } from "./mcp-auth";

describe("MCP Auth", () => {
  const testWallet = "7rQ5mDWBpxq5M3kqfcfLFXhN3Hx4TfqvWYQGWr5GwqPq";
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
});
