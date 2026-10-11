import "server-only";

import {
  getPdaTickArrayAddress, PersonalPositionLayout, TickArrayLayout, TickArrayUtil,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { ExtensionType, getAccountLen, getAccountTypeOfMintType, getExtensionTypes, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";

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
  walletTokenAccountLamports?: bigint;
};

export async function estimateOpenPositionRent(input: {
  connection: Connection;
  programId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  tokenAccounts?: { ata: string; mint: string; program: string }[];
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
  const walletTokenAccountLamports = await estimateWalletTokenAccountRent(connection, input.tokenAccounts ?? []);
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
    walletTokenAccountLamports,
  };
}

export async function estimateWalletTokenAccountRent(
  connection: Connection, accounts: { ata: string; mint: string; program: string }[],
) {
  const unique = [...new Map(accounts.map(account => [account.ata, account])).values()];
  if (!unique.length) return 0n;
  const infos = await connection.getMultipleAccountsInfo(unique.map(account => new PublicKey(account.ata)), "confirmed");
  const missing = unique.filter((_, index) => !infos[index]);
  if (!missing.length) return 0n;
  const mints = await connection.getMultipleAccountsInfo(missing.map(account => new PublicKey(account.mint)), "confirmed");
  const rents = await Promise.all(missing.map(async (account, index) => {
    const program = new PublicKey(account.program);
    const mint = unpackMint(new PublicKey(account.mint), mints[index] ?? null, program);
    // Match Token-2022's required_init_account_extensions, rather than the
    // SDK's broader mapping (confidential accounts require a separate opt-in).
    // https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
    const required = new Set([ExtensionType.TransferFeeConfig, ExtensionType.NonTransferable,
      ExtensionType.TransferHook, ExtensionType.PausableConfig]);
    const extensions = getExtensionTypes(mint.tlvData).filter(type => required.has(type)).map(getAccountTypeOfMintType);
    // Associated Token Program always initializes ImmutableOwner for Token-2022.
    if (program.equals(TOKEN_2022_PROGRAM_ID)) extensions.push(ExtensionType.ImmutableOwner);
    return BigInt(await connection.getMinimumBalanceForRentExemption(getAccountLen(extensions), "confirmed"));
  }));
  return rents.reduce((sum, rent) => sum + rent, 0n);
}

function isOwnedAccount(info: AccountInfo<Buffer> | null | undefined, owner: PublicKey) {
  return Boolean(info && info.owner.equals(owner) && info.data.length > 0);
}
