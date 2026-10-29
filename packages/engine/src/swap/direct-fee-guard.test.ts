import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { requireInputFeeAccount, SwapFeeAccountMissingError } from "./collection";
import { assertNoDirectFeeWalletInstructions, DirectFeeWalletInstructionError } from "./fee";

const feeWallet = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

describe("assertNoDirectFeeWalletInstructions", () => {
  it("rejects a SOL transfer to the fee wallet", () => {
    expect(() => assertNoDirectFeeWalletInstructions([SystemProgram.transfer({ fromPubkey: user, toPubkey: feeWallet, lamports: 1 })], feeWallet))
      .toThrow(DirectFeeWalletInstructionError);
  });
  it.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])("rejects a TransferChecked into the fee wallet's ATA (%s)", program => {
    const source = getAssociatedTokenAddressSync(mint, user, true, program);
    const destination = getAssociatedTokenAddressSync(mint, feeWallet, true, program);
    expect(() => assertNoDirectFeeWalletInstructions([createTransferCheckedInstruction(source, mint, destination, user, 1n, 6, [], program)], feeWallet))
      .toThrow(DirectFeeWalletInstructionError);
  });
  it("rejects creating a fee-wallet ATA in the user's transaction", () => {
    const ata = getAssociatedTokenAddressSync(mint, feeWallet, true, TOKEN_2022_PROGRAM_ID);
    expect(() => assertNoDirectFeeWalletInstructions([createAssociatedTokenAccountIdempotentInstruction(user, ata, feeWallet, mint, TOKEN_2022_PROGRAM_ID)], feeWallet))
      .toThrow(DirectFeeWalletInstructionError);
  });
  it("allows ordinary user transfers and is a no-op with no fee wallet", () => {
    const other = Keypair.generate().publicKey;
    const ix = createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, user), mint, getAssociatedTokenAddressSync(mint, other), user, 1n, 6);
    expect(() => assertNoDirectFeeWalletInstructions([ix, SystemProgram.transfer({ fromPubkey: user, toPubkey: other, lamports: 1 })], feeWallet)).not.toThrow();
    expect(() => assertNoDirectFeeWalletInstructions([SystemProgram.transfer({ fromPubkey: user, toPubkey: feeWallet, lamports: 1 })], null)).not.toThrow();
  });
});

function tokenAccount(owner: PublicKey, accountMint: PublicKey) {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: accountMint, owner, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return data;
}

describe("requireInputFeeAccount", () => {
  it("resolves a Token-2022 input mint's fee ATA from the mint owner", async () => {
    const ata = getAssociatedTokenAddressSync(mint, feeWallet, true, TOKEN_2022_PROGRAM_ID);
    const getAccountInfo = vi.fn(async (address: PublicKey) => address.equals(mint)
      ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) }
      : address.equals(ata) ? { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(feeWallet, mint) } : null);
    await expect(requireInputFeeAccount({ getAccountInfo } as never, feeWallet, mint)).resolves.toEqual(ata);
  });
  it("fails closed with a token message when the fee ATA is missing", async () => {
    const getAccountInfo = vi.fn(async (address: PublicKey) => address.equals(mint) ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(82) } : null);
    const error = await requireInputFeeAccount({ getAccountInfo } as never, feeWallet, mint).catch(e => e);
    expect(error).toBeInstanceOf(SwapFeeAccountMissingError);
    expect(error.message).toMatch(/input token is not set up/);
  });
  it("refuses a mint owned by an unknown program", async () => {
    const getAccountInfo = vi.fn(async () => ({ owner: Keypair.generate().publicKey, data: Buffer.alloc(82) }));
    await expect(requireInputFeeAccount({ getAccountInfo } as never, feeWallet, mint)).rejects.toThrow(/not SPL Token or Token-2022/);
  });
});
