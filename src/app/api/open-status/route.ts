import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { parseWallet } from "@/lib/api-input";
import { parseOpenAttempt, type OpenAttemptStatus } from "@/lib/open-attempt";
import { rpcConnection } from "@/lib/rpc";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid open-position verification input");
    const fields = body as Record<string, unknown>;
    const wallet = parseWallet(fields.wallet);
    const attempt = parseOpenAttempt(fields.attempt, wallet);
    if (!attempt || getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, new PublicKey(attempt.nftMint)).publicKey.toBase58() !== attempt.positionAccount) {
      throw new Error("Invalid open-position verification input");
    }
    const connection = rpcConnection();
    const respond = (status: OpenAttemptStatus) => Response.json({ signature: attempt.signature, status },
      { headers: { "Cache-Control": "no-store" } });
    const observed = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
    if (!observed) {
      if (await connection.getBlockHeight("finalized") <= attempt.lastValidBlockHeight) return respond("pending");
      // Missing/pruned signature history must not permit a duplicate when the NFT's position exists.
      const position = await connection.getAccountInfo(new PublicKey(attempt.positionAccount), "finalized");
      return respond(position ? "manual-review" : "expired");
    }
    if (observed.confirmationStatus !== "finalized") return respond("pending");
    if (observed.err) return respond("failed");
    const transaction = await connection.getParsedTransaction(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!transaction) return respond("pending");
    if (!transaction.meta) return respond("pending");
    if (transaction.meta.err) return respond("failed");
    const keys = transaction.transaction.message.accountKeys;
    if (!keys[0]?.signer || keys[0].pubkey.toBase58() !== wallet ||
      !keys.some(key => key.signer && key.pubkey.toBase58() === attempt.nftMint) ||
      !keys.some(key => key.pubkey.toBase58() === attempt.positionAccount) ||
      transaction.transaction.message.recentBlockhash !== attempt.blockhash) return respond("manual-review");
    const opened = transaction.transaction.message.instructions.some(ix => {
      if (!ix.programId.equals(CLMM_PROGRAM_ID) || !("accounts" in ix)) return false;
      const data = Buffer.from(bs58.decode(ix.data));
      const variants = [["open_position_v2", 5, 9], ["open_position_with_token22_nft", 4, 8]] as const;
      return variants.some(([name, poolIndex, positionIndex]) =>
        data.subarray(0, 8).equals(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)) &&
        ix.accounts[0]?.toBase58() === wallet && ix.accounts[1]?.toBase58() === wallet && ix.accounts[2]?.toBase58() === attempt.nftMint &&
        ix.accounts[poolIndex]?.toBase58() === attempt.poolId && ix.accounts[positionIndex]?.toBase58() === attempt.positionAccount);
    });
    if (!opened) return respond("manual-review");
    const info = await connection.getAccountInfo(new PublicKey(attempt.positionAccount), { commitment: "finalized", minContextSlot: observed.slot });
    const discriminator = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
    if (!info || !info.owner.equals(CLMM_PROGRAM_ID) || !info.data.subarray(0, 8).equals(discriminator)) return respond("manual-review");
    const position = PersonalPositionLayout.decode(info.data);
    if (position.nftMint.toBase58() !== attempt.nftMint || position.poolId.toBase58() !== attempt.poolId ||
      position.tickLower !== attempt.tickLower || position.tickUpper !== attempt.tickUpper ||
      BigInt(position.liquidity.toString()) < BigInt(attempt.liquidity)) return respond("manual-review");
    return respond("confirmed");
  } catch (error) { return apiError(error, "Open-position verification failed"); }
}
