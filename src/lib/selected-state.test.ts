import { describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
vi.mock("./wallet-discovery", () => ({ discoverWallet: vi.fn() }));

import { discoverWallet } from "./wallet-discovery";
import { readSelectedPositionState } from "./selected-state";

describe("selected position state", () => {
  it("rejects a selected NFT absent from the current wallet scan", async () => {
    const key = () => Keypair.generate().publicKey.toBase58();
    const wallet = key();
    const selection = { positionMint: key(), inputMint: key(), inputKind: "token" as const };
    vi.mocked(discoverWallet).mockResolvedValue({ wallet, slot: 1, fetchedAt: 1,
      positions: [], assets: [{ kind: "token", mint: selection.inputMint, tokenProgram: key(),
        decimals: 6, balance: "100", totalBalance: "100", account: key(), eligible: true, reason: null }],
    });
    await expect(readSelectedPositionState(wallet, selection, {} as Connection)).rejects.toThrow("does not currently hold this Raydium CLMM position NFT");
  });

  it("rejects a native SOL selection with a different mint", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const selection = { positionMint: Keypair.generate().publicKey.toBase58(),
      inputMint: Keypair.generate().publicKey.toBase58(), inputKind: "native" as const };
    await expect(readSelectedPositionState(wallet, selection, {} as Connection)).rejects.toThrow("Native SOL mint mismatch");
  });
});
