import "server-only";
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NATIVE_SOL_MINT } from "../ids";
import { verifiedTokenAmount } from "../lp-exit-verification";
import { transactionIntermediateAccounts, verifyIntermediateAccounts } from "../swap/instructions";
import type { WithdrawSummary } from "./types";
export async function simulateWithdraw(connection: Connection, transaction: VersionedTransaction, summary: WithdrawSummary, sigVerify = false) {
    const wallet = new PublicKey(summary.wallet);
    const outputKeys = summary.outputs.map(o => getAssociatedTokenAddressSync(new PublicKey(o.mint), wallet, false, new PublicKey(summary.assets.find(a => a.mint === o.mint)?.program ?? TOKEN_PROGRAM_ID.toBase58())).toBase58());
    const allowed = [...summary.assets.map(a => a.account), ...outputKeys, ...(summary.isolatedSources ?? []).map(a => a.address)];
    const intermediate = await transactionIntermediateAccounts(connection, transaction, wallet, allowed);
    const addresses = [...new Set([wallet.toBase58(), summary.positionAccount, ...allowed, ...intermediate.accounts.map(a => a.address)])];
    const before = await connection.getMultipleAccountsInfoAndContext(addresses.map(a => new PublicKey(a)), "confirmed");
    const simulation = await connection.simulateTransaction(transaction, { sigVerify, replaceRecentBlockhash: !sigVerify,
        minContextSlot: Math.max(before.context.slot, intermediate.slot), accounts: { encoding: "base64", addresses } });
    if (simulation.value.err || !simulation.value.accounts)
        throw new Error(`Withdrawal simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const after = simulation.value.accounts;
    const nativeBefore = before.value[0], nativeAfter = after[0];
    if (!nativeBefore || !nativeAfter || BigInt(nativeAfter.lamports) - BigInt(nativeBefore.lamports) < -BigInt(summary.maxSolDebitLamports))
        throw new Error("Withdrawal exceeds SOL cost budget");
    for (const source of summary.isolatedSources ?? []) {
        const i = addresses.indexOf(source.address);
        if (before.value[i])
            throw new Error("Isolated withdrawal source already exists");
        if (after[i]?.lamports)
            throw new Error("Isolated withdrawal source did not close");
    }
    verifyIntermediateAccounts(intermediate.accounts, addresses, after, wallet);
    for (const asset of summary.assets) {
        const i = addresses.indexOf(asset.account), prior = before.value[i];
        const starting = prior ? verifiedTokenAmount(prior.data.toString("base64"), wallet, new PublicKey(asset.mint), prior.owner.toBase58()) : 0n;
        if (starting !== BigInt(asset.starting))
            throw new Error("Wallet token balance changed; prepare again");
        const actual = after[i];
        const balance = actual && actual.lamports > 0 ? verifiedTokenAmount(actual.data[0], wallet, new PublicKey(asset.mint), actual.owner) : 0n;
        // For a withdrawal leg, preserve all prior inventory, even when swapping.
        const floor = summary.stage === "swap" ? starting - BigInt(asset.amount) : starting;
        if (summary.receive === "token" && summary.outputMint === NATIVE_SOL_MINT && asset.mint === NATIVE_SOL_MINT && summary.stage !== "withdraw")
            continue;
        if (summary.stage === "withdraw" && balance - starting < BigInt(asset.amount))
            throw new Error("Withdrawal received below simulated minimum");
        if (balance < floor)
            throw new Error("Withdrawal would consume existing wallet inventory");
    }
    for (const [n, output] of summary.outputs.entries()) {
        if (summary.stage === "withdraw")
            break;
        if (summary.stage === "swap" && output.mint !== NATIVE_SOL_MINT && summary.assets.some(a => a.mint === output.mint)) {
            const i = addresses.indexOf(outputKeys[n]!);
            const actual = after[i];
            if (!actual || verifiedTokenAmount(actual.data[0], wallet, new PublicKey(output.mint), actual.owner) < BigInt(summary.assets.find(a => a.mint === output.mint)!.starting) + BigInt(output.minimum) - BigInt(summary.assets.find(a => a.mint === output.mint)!.amount))
                throw new Error("Swap output below minimum");
            continue;
        }
        if (summary.receive === "token" && output.mint === NATIVE_SOL_MINT) {
            const nativeDelta = BigInt(after[0]?.lamports ?? 0) - BigInt(before.value[0]?.lamports ?? 0);
            if (nativeDelta < BigInt(output.minimum) - BigInt(summary.maxSolDebitLamports))
                throw new Error("Native SOL output below minimum");
            continue;
        }
        const i = addresses.indexOf(outputKeys[n]!);
        const prior = before.value[i], actual = after[i];
        const baseline = prior ? prior.data.readBigUInt64LE(64) : 0n;
        const received = actual ? verifiedTokenAmount(actual.data[0], wallet, new PublicKey(output.mint), actual.owner) - baseline : 0n;
        if (received < BigInt(output.minimum))
            throw new Error("Simulated output below minimum");
    }
    if (summary.closesPosition && summary.stage !== "swap" && after[addresses.indexOf(summary.positionAccount)]?.lamports)
        throw new Error("Position did not close");
    const positionAfter = after[addresses.indexOf(summary.positionAccount)];
    if (summary.stage !== "swap" && !summary.closesPosition) {
        if (!positionAfter || PersonalPositionLayout.decode(Buffer.from(positionAfter.data[0]!, "base64")).liquidity.toString() !== (BigInt(summary.startingLiquidity) - BigInt(summary.removedLiquidity)).toString())
            throw new Error("Remaining position amount mismatch");
    }
    return { simulation, before, addresses };
}
