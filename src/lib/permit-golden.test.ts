// GOLDEN HMAC VECTORS, captured from `main` (8f23b7f) BEFORE lib/auth/permit.ts existed.
// They must stay byte-identical forever: a change would invalidate every permit already issued
// (a user who prepared a transaction before a deploy and signs after it). If this test fails, the
// refactor changed the permit bytes: fix the refactor, never the vectors.
import { describe, expect, it } from "vitest";
import { issueCompoundPermit, verifyCompoundPermit } from "./compound-permit";
import { issueOpenPositionPermit, verifyOpenPositionPermit } from "./open-permit";

const INPUTS: Record<string, unknown> = {
  basic: { wallet: "WalletA", message: "bXNn", summary: { operation: "open-position", poolId: "Pool1", nftMint: "Nft1", tickLower: -30, tickUpper: 30, quote: { requested: "100", liquidity: "5", inputMint: "Mint1" } } },
  reordered: { message: "bXNn", summary: { quote: { inputMint: "Mint1", liquidity: "5", requested: "100" }, tickUpper: 30, tickLower: -30, nftMint: "Nft1", poolId: "Pool1", operation: "open-position" }, wallet: "WalletA" },
  undefinedField: { wallet: "WalletA", message: "bXNn", summary: { a: 1, b: undefined, c: [1, undefined, null, "x"] } },
  unicode: { wallet: "W", message: "m", summary: { note: "日本語 \"quoted\" \\ \n tab\t", n: 1.5e21, neg: -0, big: "9007199254740993" } },
  nullSummary: { wallet: "W", message: "m", summary: null },
  missingSummary: { wallet: "W", message: "m", summary: undefined },
  primitiveSummary: { wallet: "W", message: "m", summary: "plain string" },
  emptyStrings: { wallet: "", message: "", summary: {} },
  deepArray: { wallet: "W", message: "m", summary: { list: [{ z: 1, a: [2, { y: null, b: false }] }, [], {}], flag: true } },
};

const SECRET_A = "golden-secret-A";
const SECRET_B = "golden-secret-B-\u{1F49A}";

const GOLDEN: Record<string, { open: string; compound: string; openB: string; compoundB: string }> = {
  "basic": {
    "open": "67f91b498c6df912d0bb82534bc2d9615569b5cf4bd6c20652270cd7f9215048",
    "compound": "60637da7d0bc65ef87144efb9bd67da0b93b66bd4f1f8b9b3b2883221ad9aee1",
    "openB": "93d1ef3e7e510b96254301b50cc5a8a11e52c416fa762bfb729c57f3a0be9bfa",
    "compoundB": "1d80e3ab1a55f18f043ca4755da9b69cba2ae97cbcbbd164aa0532f3d788ac40"
  },
  "reordered": {
    "open": "67f91b498c6df912d0bb82534bc2d9615569b5cf4bd6c20652270cd7f9215048",
    "compound": "60637da7d0bc65ef87144efb9bd67da0b93b66bd4f1f8b9b3b2883221ad9aee1",
    "openB": "93d1ef3e7e510b96254301b50cc5a8a11e52c416fa762bfb729c57f3a0be9bfa",
    "compoundB": "1d80e3ab1a55f18f043ca4755da9b69cba2ae97cbcbbd164aa0532f3d788ac40"
  },
  "undefinedField": {
    "open": "2b90b9dd0079fd267af450cc28bc9a856e28854f0ee03f77daab45a16a37ef4e",
    "compound": "5733488a1095b8152e39b97d5de03e098322025ab57bf33fc39f10c86b51882b",
    "openB": "e2f70799d0d3b36c701b7d8c4c43e93bc914c59cb0918d1403c3c531136757e1",
    "compoundB": "c54311d9b554439dca923f52121a2bfcd435b83268b58caa317174711eae60ff"
  },
  "unicode": {
    "open": "d10bd7c0dee7d93477a87541e5070814697c39313a634d69db5ae759e343958c",
    "compound": "c6024949ee97ebd3ca3b20dcdc54ec4834325f454b5f4a579eeb7675ce759c92",
    "openB": "0c02499ece8060ddfb45a71c594cdb9dac1b5f69097d18e41d9133aa9a8eff57",
    "compoundB": "b0097cdf609362f2b24c3f737aedb053b2c3a4a87f7b05c78c4f1cb87d4d904e"
  },
  "nullSummary": {
    "open": "34f8a608724336826d030e4aa850b98ea38533babf76bf554bcad51c4268dc24",
    "compound": "b34f20fd84def5d03c65c720e1071132c0033a118405fd7f080b92bc68d835b0",
    "openB": "47b7cc9142c2662e29e1f1910dc6da59c20d943138ba8e1c79c928f0238e5cb5",
    "compoundB": "82cc91b8f509f007a736e0b1340f631853f5d8b42ed05e5721974639a025e5bd"
  },
  "missingSummary": {
    "open": "64714a96dfd0a0942e2a14230292fa7f7898a4f37d57ab501f7195f4fb5a64d0",
    "compound": "1415f86bb6c4bed15066111c538469753cf59eb335ff101361fd37a8a838f125",
    "openB": "6fff0cee8fc506ff3ecc5589afc6d114a6b9c34d65b7a3003c435662cf7b5d40",
    "compoundB": "d69415594a367d2fed7cacb3fd738f8433866a678edeb9dc6f1d812cf6c19085"
  },
  "primitiveSummary": {
    "open": "6c2959f43348fa4bde68dcd2e3390a839174f6db627fc1fbe257ea340b096dd9",
    "compound": "97809b8bdca9b379635142720c4ac0a40a3d1ef2353a0c591c60243a2f455ca6",
    "openB": "573266556af88857c9bb836efcfdb3eed76406276f8d18a845b90e5ce4d2c929",
    "compoundB": "c63499c92507283ce121dcbf3a02eaa88667b7c273aaffd2c643a3ee8e360f2e"
  },
  "emptyStrings": {
    "open": "37e5d28b192fcc87262991d107a58adf161baaab09499620613d777373878f34",
    "compound": "ede4afe214a70c0a29aa03cc9e1b93fbfc631710c7d8e9fffefbe468d3b9ec7e",
    "openB": "111785c069bdfe578663de2805ee75092be8a22f246386b48abf1c0f32881a22",
    "compoundB": "763aaaf1aea7af372ecad1bc9e5909fcda38aad56f4668300ef89960a8cad0a5"
  },
  "deepArray": {
    "open": "3a9894400cc942f19b412276ae711c22d324ac2277ad4aeb96798f01d94066a4",
    "compound": "e776ac220c984c787e5bf98367b729d02e70a693041ae46c43fa742db53b6eea",
    "openB": "edee92225d9ca87ab5aae6b51b304d1df4010eeb8fc41a9de06520be97a85c6f",
    "compoundB": "30829013ce3735f554a249fc449303cea8fa30a2b8bc16def9d935fad06500eb"
  }
};

describe("golden permit vectors (captured before the createPermit refactor)", () => {
  it.each(Object.keys(INPUTS))("%s: open + compound permits are byte-identical", (name) => {
    const input = INPUTS[name] as never;
    const golden = GOLDEN[name]!;
    expect(issueOpenPositionPermit(SECRET_A, input)).toBe(golden.open);
    expect(issueCompoundPermit(SECRET_A, input)).toBe(golden.compound);
    expect(issueOpenPositionPermit(SECRET_B, input)).toBe(golden.openB);
    expect(issueCompoundPermit(SECRET_B, input)).toBe(golden.compoundB);
  });

  it.each(Object.keys(INPUTS))("%s: a golden permit verifies, and only for its own domain and secret", (name) => {
    const input = INPUTS[name] as never;
    const golden = GOLDEN[name]!;
    expect(verifyOpenPositionPermit(SECRET_A, input, golden.open)).toBe(true);
    expect(verifyCompoundPermit(SECRET_A, input, golden.compound)).toBe(true);
    expect(verifyOpenPositionPermit(SECRET_A, input, golden.compound)).toBe(false);
    expect(verifyCompoundPermit(SECRET_A, input, golden.open)).toBe(false);
    expect(verifyOpenPositionPermit(SECRET_B, input, golden.open)).toBe(false);
  });

  it("domains stay distinct and permit strings stay lowercase 64-hex", () => {
    for (const golden of Object.values(GOLDEN)) {
      expect(golden.open).not.toBe(golden.compound);
      for (const value of Object.values(golden)) expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("edge behaviour is pinned: empty secret throws, non-string / malformed / uppercase permits are false", () => {
    const input = INPUTS.basic as never;
    expect(() => issueOpenPositionPermit("", input)).toThrow("Missing server signing key");
    expect(() => issueCompoundPermit("", input)).toThrow("Missing server signing key");
    expect(() => verifyOpenPositionPermit("", input, GOLDEN.basic!.open)).toThrow("Missing server signing key");
    for (const bad of [undefined, null, 5, {}, "", "xyz", GOLDEN.basic!.open.toUpperCase(), `${GOLDEN.basic!.open}0`]) {
      expect(verifyOpenPositionPermit(SECRET_A, input, bad)).toBe(false);
      expect(verifyCompoundPermit(SECRET_A, input, bad)).toBe(false);
    }
  });
});
