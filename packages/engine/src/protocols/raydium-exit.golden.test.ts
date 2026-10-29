// Golden test: exit instructions through the protocol adapter equal the Raydium SDK reference.
// Kept apart from raydium.golden.test.ts because that file mocks the Raydium SDK for the open replay.
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import { CLMM_PROGRAM_ID, ClmmInstrument, getPdaExBitmapAccount, getPdaProtocolPositionAddress, getPdaTickArrayAddress, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";

vi.mock("server-only", () => ({}));

import * as lpExit from "../lp-exit-instructions";
import { getProtocolAdapter } from "./registry";

describe("exit instruction list is unchanged", () => {
  it.each([true, false])("exit: decrease (+ close=%s) matches the Raydium SDK instructions exactly", (closePosition) => {
    const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
    const owner = key(1), nftKey = key(2), positionKey = key(3), poolId = key(4), nftMint = key(5);
    const recipients = [key(6), key(7), key(8)];
    const rewardMint = key(9), rewardVault = key(10);
    const position = { poolId, nftMint, tickLower: -120, tickUpper: 136 } as never;
    const pool = { tickSpacing: 8, vaultA: key(11), vaultB: key(12), mintA: key(13), mintB: key(14),
      rewardInfos: [{ mint: rewardMint, vault: rewardVault }, { mint: PublicKey.default, vault: PublicKey.default }] } as never;
    const input = { owner, nftKey, positionKey, nftProgram: TOKEN_2022_PROGRAM_ID, position, pool, recipients, amount: new BN(123456789), closePosition,
      minimumA: new BN(11), minimumB: new BN(22) };
    const viaAdapter = getProtocolAdapter().buildPositionExitInstructions(input);
    const tick = (value: number) => getPdaTickArrayAddress(CLMM_PROGRAM_ID, poolId, TickArrayUtil.getTickArrayStartIndex(value, 8)).publicKey;
    const reference = [
      ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, owner, nftKey, positionKey, poolId,
        getPdaProtocolPositionAddress(CLMM_PROGRAM_ID, poolId, -120, 136).publicKey, tick(-120), tick(136), recipients[0]!, recipients[1]!,
        key(11), key(12), key(13), key(14), [{ poolRewardVault: rewardVault, ownerRewardVault: recipients[2]!, rewardMint }],
        new BN(123456789), new BN(11), new BN(22), getPdaExBitmapAccount(CLMM_PROGRAM_ID, poolId).publicKey),
      ...(closePosition ? [ClmmInstrument.closePositionInstruction(CLMM_PROGRAM_ID, owner, nftMint, nftKey, positionKey, true, poolId)] : []),
    ];
    expect(viaAdapter).toEqual(reference);
    expect(viaAdapter).toEqual(lpExit.buildPositionExitInstructions(input));
    expect(viaAdapter.map(ix => ({ program: ix.programId.toBase58(), data: ix.data.toString("hex"), keys: ix.keys.length }))).toMatchSnapshot();
  });
});
