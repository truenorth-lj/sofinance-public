import "server-only";

import {
  getPdaTickArrayAddress, PersonalPositionLayout, TickArrayLayout, TickArrayUtil,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";

// Token-2022 NFT from open_position_with_token22_nft + withMetadata "no-create":
// mintCloseAuthority only. Live mint space is 202, not a 698-byte metadata mint.
const TOKEN_2022_NFT_MINT_SPACE = 202;
const TOKEN_2022_NFT_ATA_SPACE = 170;

export type OpenPositionRent = {
  refundableLamports: bigint;
  nonRefundableLamports: bigint;
  positionNftLamports: bigint;
  nftAtaLamports: bigint;
  personalPositionLamports: bigint;
  tickArrayLamports: bigint;
  protocolPositionLamports: bigint;
  tickArrayInitRequired: boolean;
  protocolPositionInitRequired: boolean;
  tickArrayAccounts: string[];
};

export async function estimateOpenPositionRent(input: {
  connection: Connection;
  programId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
}): Promise<OpenPositionRent> {
  const { connection, tickLower, tickUpper, tickSpacing } = input;
  const program = new PublicKey(input.programId);
  const pool = new PublicKey(input.poolId);
  const starts = [...new Set([
    TickArrayUtil.getTickArrayStartIndex(tickLower, tickSpacing),
    TickArrayUtil.getTickArrayStartIndex(tickUpper, tickSpacing),
  ])];
  const tickArrayKeys = starts.map((start) => getPdaTickArrayAddress(program, pool, start).publicKey);
  const tickInfos = await connection.getMultipleAccountsInfo(tickArrayKeys, "confirmed");
  const missingTickArrays = tickArrayKeys.filter((_, index) => !isOwnedAccount(tickInfos[index], program));
  const [
    positionNftLamports,
    nftAtaLamports,
    personalPositionLamports,
    tickArrayRentEach,
  ] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(TOKEN_2022_NFT_MINT_SPACE, "confirmed"),
    connection.getMinimumBalanceForRentExemption(TOKEN_2022_NFT_ATA_SPACE, "confirmed"),
    connection.getMinimumBalanceForRentExemption(PersonalPositionLayout.span, "confirmed"),
    connection.getMinimumBalanceForRentExemption(TickArrayLayout.span, "confirmed"),
  ]);
  const tickArrayLamports = BigInt(tickArrayRentEach) * BigInt(missingTickArrays.length);
  // open_position_with_token22_nft marks protocol_position read-only, so a
  // missing protocol PDA is not created and is not a rent cost for this path.
  const refundable = BigInt(positionNftLamports) + BigInt(nftAtaLamports) + BigInt(personalPositionLamports);
  return {
    refundableLamports: refundable,
    nonRefundableLamports: tickArrayLamports,
    positionNftLamports: BigInt(positionNftLamports),
    nftAtaLamports: BigInt(nftAtaLamports),
    personalPositionLamports: BigInt(personalPositionLamports),
    tickArrayLamports,
    protocolPositionLamports: 0n,
    tickArrayInitRequired: missingTickArrays.length > 0,
    protocolPositionInitRequired: false,
    tickArrayAccounts: missingTickArrays.map((key) => key.toBase58()),
  };
}

function isOwnedAccount(info: AccountInfo<Buffer> | null | undefined, owner: PublicKey) {
  return Boolean(info && info.owner.equals(owner) && info.data.length > 0);
}
