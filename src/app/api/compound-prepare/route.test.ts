import BN from "bn.js";
import { ClmmInstrument, getPdaExBitmapAccount, getPdaObservationAccount, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/compound-api", () => ({ parseCompoundSelection: vi.fn() }));
vi.mock("@/lib/dex", async (original) => ({
  ...await original<typeof import("@/lib/dex")>(),
  prepareCompound: vi.fn(),
}));

import { parseCompoundSelection } from "@/lib/compound-api";
import { prepareCompound } from "@/lib/dex";
import { CompoundSwapGuardError, validateCompoundSwapInstruction, type CompoundSwap, type CompoundSwapShape } from "@sofinance/engine/compound-swap";
import type { CompoundAccount, CompoundPositionState } from "@sofinance/engine/compound-types";
import { POST } from "./route";

const key = () => Keypair.generate().publicKey.toBase58();
function shortSwapError() {
  const state = { wallet: key(), poolId: key(), programId: key(), mintA: key(), mintB: key(), vaultA: key(), vaultB: key(),
    ataA: key(), ataB: key() } as CompoundPositionState;
  const accounts = [{ address: key(), mint: state.mintA, program: TOKEN_PROGRAM_ID.toBase58() },
    { address: key(), mint: state.mintB, program: TOKEN_PROGRAM_ID.toBase58() }] as [CompoundAccount, CompoundAccount];
  const pub = (value: string) => new PublicKey(value), program = pub(state.programId), pool = pub(state.poolId);
  const config = key();
  const observation = getPdaObservationAccount(program, pool).publicKey.toBase58();
  const tickArrays = [getPdaTickArrayAddress(program, pool, 0).publicKey.toBase58()];
  const swap: CompoundSwap = { inputMint: state.mintB, outputMint: state.mintA, inputAmount: "100", quotedOutputAmount: "90",
    minOutputAmount: "89", inputDecimals: 6, outputDecimals: 6, poolId: state.poolId, sqrtPriceAfterX64: (1n << 64n).toString(),
    feeBps: 0, feeAmount: "0" };
  const ix = ClmmInstrument.swapV2Instruction(program, pub(state.wallet), pool, pub(config), pub(accounts[1].address), pub(accounts[0].address),
    pub(state.vaultB), pub(state.vaultA), pub(state.mintB), pub(state.mintA), tickArrays.map(pub), pub(observation), new BN(100), new BN(89), new BN(0), true,
    getPdaExBitmapAccount(program, pool).publicKey);
  ix.data = Buffer.from(ix.data.subarray(0, 10));
  expect(ix.data.length).toBe(10);
  try {
    validateCompoundSwapInstruction(ix, { state, accounts, swap, config, observation, onChainObservation: observation, tickArrays } satisfies CompoundSwapShape);
  } catch (error) {
    return error;
  }
  throw new Error("expected CompoundSwapGuardError");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(parseCompoundSelection).mockResolvedValue({ wallet: key(), positionMint: key(), sourceSignatures: [] });
});
afterEach(() => vi.restoreAllMocks());

it("maps a 10-byte swap_v2 to a 400 data_length_mismatch", async () => {
  const error = shortSwapError();
  expect(error).toBeInstanceOf(CompoundSwapGuardError);
  expect((error as CompoundSwapGuardError).code).toBe("data_length_mismatch");
  vi.mocked(prepareCompound).mockRejectedValue(error);
  const response = await POST(new Request("http://localhost/api/compound-prepare", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
  const body = await response.json() as { error: string; code?: string };
  expect(response.status).toBe(400);
  expect(body.code).toBe("data_length_mismatch");
  expect(body.error).toBe("Compound swap data length mismatch");
});
