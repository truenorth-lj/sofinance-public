import "server-only";
import { PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { verifiedTokenAmount } from "../lp-exit-verification";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { rpcConnection } from "../rpc";
import { getSigningSecret } from "../config/server-env";
import { withdrawPermit } from "./permit";
import type { WithdrawPrepared } from "./types";
/** Compare the confirmed transaction's complete message with its server authorization. */
export async function withdrawStatus(input: {
    signature: string;
    prepared: WithdrawPrepared;
}) {
    if (bs58.decode(input.signature).length !== 64)
        throw new Error("Invalid signature");
    const { summary, permit, unsignedTransaction } = input.prepared;
    const expected = VersionedTransaction.deserialize(Buffer.from(unsignedTransaction, "base64"));
    if (!withdrawPermit.verify(getSigningSecret(), { wallet: summary.wallet, message: Buffer.from(expected.message.serialize()).toString("base64"), summary }, permit))
        throw new Error("Invalid withdrawal authorization");
    const connection = rpcConnection();
    const observed = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
    if (observed?.err)
        return { status: "failed", signature: input.signature };
    if (observed?.confirmationStatus !== "finalized") {
        if (observed || await connection.getBlockHeight("confirmed") <= summary.lastValidBlockHeight)
            return { status: "pending", signature: input.signature };
        const historical = await connection.getTransaction(input.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        if (historical?.meta && !historical.meta.err && Buffer.from(historical.transaction.message.serialize()).equals(Buffer.from(expected.message.serialize())))
            return { status: "success", signature: input.signature, stage: summary.stage };
        // An absent signature is not enough to declare an attempted withdrawal safe to retry.
        const keys = [...summary.assets.map(a => new PublicKey(a.account)), new PublicKey(summary.positionAccount)];
        const balances = await connection.getMultipleAccountsInfo(keys, "finalized");
        const unchanged = summary.assets.every((a, i) => {
            const info = balances[i];
            return (info ? verifiedTokenAmount(info.data.toString("base64"), new PublicKey(summary.wallet), new PublicKey(a.mint), info.owner.toBase58()) : 0n) === BigInt(a.starting);
        }) && (summary.stage === "swap" || !!balances.at(-1) && PersonalPositionLayout.decode(balances.at(-1)!.data).liquidity.toString() === summary.startingLiquidity);
        return { status: unchanged ? "expired" : "manual-review", signature: input.signature };
    }
    const receipt = await connection.getTransaction(input.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!receipt)
        return { status: "pending", signature: input.signature };
    if (!receipt.meta)
        return { status: "manual-review", signature: input.signature };
    if (receipt.meta.err)
        return { status: "failed", signature: input.signature };
    return { status: Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(expected.message.serialize())) ? "success" : "manual-review", signature: input.signature, stage: summary.stage };
}
