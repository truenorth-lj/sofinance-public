import { PublicKey } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as compoundSwap from "../compound-swap";
import { buildCompoundSwapPlan } from "./compound";
import type { CompoundAccount, CompoundPositionState } from "../compound-types";

afterEach(() => {
  vi.restoreAllMocks();
});

const key = () => PublicKey.unique().toBase58();

it("feeds getAccountInfo(state.poolId) into decodeOnChainPoolObservation", async () => {
  const decode = vi.spyOn(compoundSwap, "decodeOnChainPoolObservation");
  const state = {
    wallet: key(), poolId: key(), programId: key(), mintA: key(), mintB: key(),
    vaultA: key(), vaultB: key(), ataA: key(), ataB: key(), tickSpacing: 1,
  } as CompoundPositionState;
  const accounts = [
    { address: key(), mint: state.mintA, program: TOKEN_PROGRAM_ID.toBase58() },
    { address: key(), mint: state.mintB, program: TOKEN_PROGRAM_ID.toBase58() },
  ] as [CompoundAccount, CompoundAccount];
  const configId = new PublicKey(key());
  const observationId = new PublicKey(key());
  const poolAccount = {
    owner: new PublicKey(state.programId),
    data: Buffer.from("pool-account"),
    executable: false,
    lamports: 1,
  };
  const getAccountInfo = vi.fn(async (pubkey: PublicKey) => {
    if (pubkey.equals(new PublicKey(state.poolId))) return poolAccount;
    return null;
  });
  const connection = {
    getEpochInfo: vi.fn(async () => ({ epoch: 1, slotIndex: 0, slotsInEpoch: 432000, absoluteSlot: 1 })),
    getSlot: vi.fn(async () => 1),
    getAccountInfo,
  };
  const poolInfo = { id: state.poolId, programId: state.programId, config: { id: configId.toBase58() } };
  const computePoolInfo = {
    id: new PublicKey(state.poolId),
    programId: new PublicKey(state.programId),
    mintA: { address: state.mintA },
    mintB: { address: state.mintB },
    vaultA: new PublicKey(state.vaultA),
    vaultB: new PublicKey(state.vaultB),
    ammConfig: { id: configId },
    observationId,
  };
  const poolKeys = { observationId: observationId.toBase58() };

  await expect(buildCompoundSwapPlan({
    connection: connection as never,
    state,
    accounts,
    poolInfo: poolInfo as never,
    poolKeys: poolKeys as never,
    computePoolInfo: computePoolInfo as never,
    tickData: {} as never,
    amountA: 0n,
    amountB: 0n,
  })).rejects.toThrow("Compound swap config program mismatch");

  expect(getAccountInfo).toHaveBeenCalledWith(new PublicKey(state.poolId), "confirmed");
  expect(decode).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledWith(poolAccount, state.programId, state);
});
