import "@/lib/engine-host";
import "server-only";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { isSingleWalletSignedTransaction } from "@sofinance/engine/transaction-limits";
import { rpcConnection } from "@sofinance/engine/rpc";
import { beamAfterSend, noBeamAfterSend } from "@/lib/beam-after-send";
import { withdrawSubmitSchema } from "@sofinance/engine/withdraw/input";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import { simulateWithdraw } from "@sofinance/engine/withdraw/build";
import { assertImpactConfirmed } from "@sofinance/engine/withdraw/quote";
import type { WithdrawSummary } from "@sofinance/engine/withdraw/types";
export async function submitWithdraw(input: {
    wallet: string;
    signedTransaction: string;
    permit: string;
    summary: WithdrawSummary;
    confirmHighImpact?: boolean;
}) {
    withdrawSubmitSchema.parse(input);
    const transaction = VersionedTransaction.deserialize(Buffer.from(input.signedTransaction, "base64"));
    const summary = input.summary;
    if (!withdrawPermit.verify(getSigningSecret(), { wallet: input.wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary }, input.permit))
        throw new Error("Withdrawal authorization does not match transaction");
    assertImpactConfirmed(summary, input.confirmHighImpact);
    if (summary.operation !== "withdraw" || summary.wallet !== input.wallet || summary.expiresAt <= Date.now() || summary.blockhash !== transaction.message.recentBlockhash || !isSingleWalletSignedTransaction(transaction, input.wallet))
        throw new Error("Invalid or expired withdrawal transaction");
    if (!nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0]!, new PublicKey(input.wallet).toBytes()))
        throw new Error("Invalid wallet signature");
    const connection = rpcConnection();
    if (await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight)
        throw new Error("Withdrawal blockhash expired");
    await simulateWithdraw(connection, transaction, summary, true);
    if (Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight)
        throw new Error("Withdrawal expired before broadcast");
    const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    if (signature !== bs58.encode(transaction.signatures[0]!))
        throw new Error("RPC transaction signature mismatch");
    const beam = await beamAfterSend(signature, summary.beam).catch(() => noBeamAfterSend(signature));
    return { signature, beam: beam.beam, beamLabel: beam.label, beamLandingUrl: beam.beamLandingUrl };
}
