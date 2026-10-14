import BN from "bn.js";
import { ClmmInstrument, CLMM_PROGRAM_ID, PersonalPositionLayout, PoolInfoLayout, getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaExBitmapAccount, TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
/** Shared decrease includes accrued fees/rewards; SDK close burns the NFT. */
export function buildPositionExitInstructions(input: {
    owner: PublicKey;
    nftKey: PublicKey;
    positionKey: PublicKey;
    nftProgram: PublicKey;
    position: ReturnType<typeof PersonalPositionLayout.decode>;
    pool: ReturnType<typeof PoolInfoLayout.decode>;
    recipients: PublicKey[];
    amount: BN;
    closePosition: boolean;
    minimumA?: BN;
    minimumB?: BN;
}) {
    const { owner, nftKey, positionKey, nftProgram, position, pool, recipients, amount } = input;
    const rewards = pool.rewardInfos.filter(r => !r.mint.equals(PublicKey.default));
    const tick = (value: number) => getPdaTickArrayAddress(CLMM_PROGRAM_ID, position.poolId, TickArrayUtil.getTickArrayStartIndex(value, pool.tickSpacing)).publicKey;
    const withdraw = ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, owner, nftKey, positionKey, position.poolId, getPdaProtocolPositionAddress(CLMM_PROGRAM_ID, position.poolId, position.tickLower, position.tickUpper).publicKey, tick(position.tickLower), tick(position.tickUpper), recipients[0]!, recipients[1]!, pool.vaultA, pool.vaultB, pool.mintA, pool.mintB, rewards.map((r, i) => ({ poolRewardVault: r.vault, ownerRewardVault: recipients[i + 2]!, rewardMint: r.mint })), amount, input.minimumA ?? new BN(0), input.minimumB ?? new BN(0), getPdaExBitmapAccount(CLMM_PROGRAM_ID, position.poolId).publicKey);
    const close = ClmmInstrument.closePositionInstruction(CLMM_PROGRAM_ID, owner, position.nftMint, nftKey, positionKey, nftProgram.equals(TOKEN_2022_PROGRAM_ID), position.poolId);
    return [withdraw, ...(input.closePosition ? [close] : [])];
}
