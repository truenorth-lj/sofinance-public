import { describe, expect, it } from "vitest";
import { walletDistinctId } from "./server-capture";
import { hashedWalletId } from "./wallet-id";

// sofi-metrics `legacy_wallet_id` gives this id for the address (sha256 of the UTF-8 string), so its
// raw-address/hashed-id folding keeps old and new events for one wallet together.
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EXPECTED = "wallet:f0f571fa2e7ec7b5470df5574dd1fc2db2929528b7e2c1d625508eb0a5ecff16";

describe("wallet distinct id", () => {
  it("is wallet:<sha256 hex> on the web (WebCrypto) and the MCP server (node:crypto)", async () => {
    expect(await hashedWalletId(WALLET)).toBe(EXPECTED);
    expect(walletDistinctId(WALLET)).toBe(EXPECTED);
  });

  it("agrees across many addresses and never contains the address", async () => {
    for (const wallet of ["So11111111111111111111111111111111111111112", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "x"]) {
      const id = await hashedWalletId(wallet);
      expect(id).toBe(walletDistinctId(wallet));
      expect(id).toMatch(/^wallet:[0-9a-f]{64}$/);
      expect(id).not.toContain(wallet === "x" ? "wallet:x" : wallet);
    }
  });
});
