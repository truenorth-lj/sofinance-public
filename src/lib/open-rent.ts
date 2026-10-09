import "server-only";

import {
  getPdaProtocolPositionAddress, getPdaTickArrayAddress, PersonalPositionLayout,
  ProtocolPositionLayout, TickArrayLayout, TickArrayUtil,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type Connection } from "@solana/web3.js";

// Token-2022 position NFT mints carry metadata extensions, larger than 82-byte legacy mints.
const TOKEN_2022_NFT_MINT_SPACE = 698;
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
  const protocolKey = getPdaProtocolPositionAddress(program, pool, tickLower, tickUpper).publicKey;
  const infos = await connection.getMultipleAccountsInfo([...tickArrayKeys, protocolKey], "confirmed");
  const missingTickArrays = tickArrayKeys.filter((_, index) => !infos[index]);
  const protocolMissing = !infos[tickArrayKeys.length];
  const [
    positionNftLamports,
    nftAtaLamports,
    personalPositionLamports,
    tickArrayRentEach,
    protocolPositionLamports,
  ] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(TOKEN_2022_NFT_MINT_SPACE, "confirmed"),
    connection.getMinimumBalanceForRentExemption(TOKEN_2022_NFT_ATA_SPACE, "confirmed"),
    connection.getMinimumBalanceForRentExemption(PersonalPositionLayout.span, "confirmed"),
    connection.getMinimumBalanceForRentExemption(TickArrayLayout.span, "confirmed"),
    connection.getMinimumBalanceForRentExemption(ProtocolPositionLayout.span, "confirmed"),
  ]);
  const tickArrayLamports = BigInt(tickArrayRentEach) * BigInt(missingTickArrays.length);
  const protocolLamports = protocolMissing ? BigInt(protocolPositionLamports) : 0n;
  const refundable = BigInt(positionNftLamports) + BigInt(nftAtaLamports) + BigInt(personalPositionLamports);
  const nonRefundable = tickArrayLamports + protocolLamports;
  return {
    refundableLamports: refundable,
    nonRefundableLamports: nonRefundable,
    positionNftLamports: BigInt(positionNftLamports),
    nftAtaLamports: BigInt(nftAtaLamports),
    personalPositionLamports: BigInt(personalPositionLamports),
    tickArrayLamports,
    protocolPositionLamports: protocolLamports,
    tickArrayInitRequired: missingTickArrays.length > 0,
    protocolPositionInitRequired: protocolMissing,
    tickArrayAccounts: missingTickArrays.map((key) => key.toBase58()),
  };
}
