import BN from "bn.js";
import { ClmmInstrument, getPdaProtocolPositionAddress, getPdaTickArrayAddress, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateCompoundRaydiumInstructions } from "./compound-atomic";
import type { CompoundAccount, CompoundPositionState } from "./compound-types";
const key = () => Keypair.generate().publicKey.toBase58();
function fixture() {
  const state = { wallet: key(), positionMint: key(), nftAta: key(), positionAccount: key(), poolId: key(), programId: key(),
    mintA: key(), mintB: key(), ataA: key(), ataB: key(), vaultA: key(), vaultB: key(), tickLower: -640, tickUpper: 640, tickSpacing: 64,
    rewards: [{ index: 0, mint: key(), vault: key(), account: key(), compounded: false }] } as unknown as CompoundPositionState;
  const accounts = [{ address: key(), mint: state.mintA, program: TOKEN_PROGRAM_ID.toBase58() }, { address: key(), mint: state.mintB, program: TOKEN_PROGRAM_ID.toBase58() }] as [CompoundAccount, CompoundAccount];
  const pub = (address: string) => new PublicKey(address);
  const program = pub(state.programId), pool = pub(state.poolId);
  const lower = getPdaTickArrayAddress(program, pool, TickArrayUtil.getTickArrayStartIndex(state.tickLower, state.tickSpacing)).publicKey;
  const upper = getPdaTickArrayAddress(program, pool, TickArrayUtil.getTickArrayStartIndex(state.tickUpper, state.tickSpacing)).publicKey;
  const protocol = getPdaProtocolPositionAddress(program, pool, state.tickLower, state.tickUpper).publicKey;
  const reward = state.rewards[0]!;
  const harvest = ClmmInstrument.decreaseLiquidityV2Instruction(program, pub(state.wallet), pub(state.nftAta), pub(state.positionAccount), pool, protocol, lower, upper,
    pub(accounts[0].address), pub(accounts[1].address), pub(state.vaultA), pub(state.vaultB), pub(state.mintA), pub(state.mintB),
    [{ poolRewardVault: pub(reward.vault), ownerRewardVault: pub(reward.account), rewardMint: pub(reward.mint) }], new BN(0), new BN(0), new BN(0));
  const add = ClmmInstrument.increaseLiquidityV2Instruction(program, pub(state.wallet), pub(state.nftAta), pub(state.positionAccount), pool, protocol, lower, upper,
    pub(accounts[0].address), pub(accounts[1].address), pub(state.vaultA), pub(state.vaultB), pub(state.mintA), pub(state.mintB), new BN(5), new BN(10), new BN(11), null);
  const validate = (instructions = [harvest, add]) => validateCompoundRaydiumInstructions(instructions, state, accounts, 5n, 10n, 11n);
  return { state, harvest, add, validate };
}
it("accepts the installed SDK's exact zero-harvest then isolated-source increase shapes", () => {
  expect(() => fixture().validate()).not.toThrow();
});
it("rejects any removal of principal or a changed add cap", () => {
  const { harvest, add, validate } = fixture();
  harvest.data.writeBigUInt64LE(1n, 8);
  expect(() => validate()).toThrow("zero-harvest");
  harvest.data.writeBigUInt64LE(0n, 8);
  add.data.writeBigUInt64LE(12n, 24);
  expect(() => validate()).toThrow("fixed liquidity");
});
it("rejects ordinary wallet balance as add source and arbitrary reward recipient", () => {
  const { state, harvest, add, validate } = fixture();
  add.keys[7]!.pubkey = new PublicKey(state.ataA);
  expect(() => validate()).toThrow("isolated yield");
  const second = fixture();
  second.harvest.keys[17]!.pubkey = Keypair.generate().publicKey;
  expect(() => second.validate()).toThrow("must not modify");
  // Every initialized reward must be present; dropping an expired reward is unsafe.
  harvest.keys.splice(16, 3);
  expect(() => validate()).toThrow();
});
it("rejects writable unrelated mints, NFT transfer, or an additional signer", () => {
  const { add, validate } = fixture();
  add.keys.push({ pubkey: Keypair.generate().publicKey, isWritable: true, isSigner: false });
  expect(() => validate()).toThrow("must not modify");
  const other = fixture();
  other.harvest.keys[1]!.isWritable = true;
  expect(() => other.validate()).toThrow("NFT");
  const third = fixture();
  third.add.keys[7]!.isSigner = true;
  expect(() => third.validate()).toThrow("must not modify");
  const fourth = fixture();
  expect(() => fourth.validate([fourth.harvest, fourth.add, new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.alloc(0) })])).toThrow("zero-harvest");
});
