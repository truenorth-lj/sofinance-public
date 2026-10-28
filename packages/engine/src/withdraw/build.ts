import BN from "bn.js";
import { randomBytes } from "node:crypto";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackMint, createCloseAccountInstruction, getAccountLenForMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createIsolatedTokenAccountInstructions, type IsolatedTokenAccount } from "../swap/isolated-account";
import { readSelectedPositionState } from "../selected-state";
import { buildPositionExitInstructions } from "../lp-exit-instructions";
import { verifiedTokenAmount } from "../lp-exit-verification";
import { compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader, versionedTransactionSize } from "../open-transaction";
import { atomicComputeUnitLimitInstruction, exceedsTxSizeLimit } from "../transaction-limits";
import { JUPITER_MAX_ACCOUNTS } from "../jupiter-route-retry";
import { NATIVE_SOL_MINT, SLIPPAGE_BPS, USDC_MINT } from "../ids";
import { feeSwapLeg } from "../swap/leg";
import { readSwapFeeConfig } from "../swap/fee";
import { collectSwapFee, fitFeeCollections, type FeeCollection } from "../swap/collection";
import { retargetSwapSource, swapRouteInstructions } from "../swap/instructions";
import type { BuildRoute } from "../swap/jupiter";
import { beamTipInstruction, chooseBeamTransaction, emptyBeamPlan, fetchBeamTipAddress, BEAM_MIN_TIP_LAMPORTS } from "../solami-beam";
import { defaultRpcConnection, rpcConnection } from "../rpc";
import { estimateFeeForMessage, WITHDRAW_FEE_ESTIMATE_MESSAGE } from "../rpc/fee-estimate";
import { getSigningSecret } from "../config/server-env";
import { simulateAtContextSlot, simulateWithdraw } from "./simulation";
import { withdrawPermit } from "./permit";
import { assertImpactConfirmed, impactFlags, percentToBps, principalMinimum, capReceivedAmount, shouldSwap, targetUSDCToBps, transactionCount } from "./quote";
import { withdrawPrepareSchema } from "./input";
import { landedTransactionMatchesPrepared } from "../wallet-returned-tx";
import type { WithdrawAsset, WithdrawPrepareRequest, WithdrawPrepared, WithdrawSummary } from "./types";
export { simulateWithdraw } from "./simulation";
async function swapInstructions(connection: Connection, wallet: PublicKey, assets: WithdrawAsset[], receive: string, output: string, pool: {
    poolId: string;
    mintA: string;
    mintB: string;
}, payer: PublicKey = wallet) {
    const config = receive === "original" ? { wallet: null, bps: 0 } : readSwapFeeConfig(), routes: BuildRoute[] = [], instructions: TransactionInstruction[] = [], collections: FeeCollection[] = [];
    const outputs = new Map<string, {
        mint: string;
        expected: string;
        minimum: string;
        decimals: number;
    }>();
    const fees: WithdrawSummary["protocolFee"]["legs"] = [];
    let impact = 0;
    for (const asset of assets) {
        const amount = BigInt(asset.amount);
        if (!amount)
            continue;
        let expected = amount, minimum = BigInt(asset.minimum ?? asset.amount), mint = asset.mint;
        if (shouldSwap(receive, mint, output)) {
            const leg = await feeSwapLeg({ wallet: wallet.toBase58(), inputMint: mint, outputMint: output, spend: amount, feeBps: config.bps, ownPool: pool, constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.compact }, maxPriceImpactBps: 10000 });
            let route = leg.route as BuildRoute;
            if (asset.source)
                route = retargetSwapSource(route, asset.account, asset.source);
            routes.push(route);
            instructions.push(...swapRouteInstructions([route], wallet));
            const bps = Number(route.priceImpactPct) * 10000;
            impact = Math.max(impact, Math.ceil(bps));
            fees.push({ mint: output === USDC_MINT ? USDC_MINT : mint, amount: output === USDC_MINT ? route.platformFee?.amount ?? "0" : leg.feeAmount.toString() });
            if (config.wallet && leg.feeAmount > 0n) {
                const collection = await collectSwapFee(connection, { kind: "token", payer, owner: wallet, recipient: config.wallet,
                    amount: leg.feeAmount, mint: new PublicKey(mint), source: new PublicKey(asset.source ?? asset.account), program: new PublicKey(asset.program), decimals: asset.decimals });
                const fee = fees.at(-1)!;
                const feeRoute = collection.routes.at(-1);
                if (feeRoute) {
                    fee.collectedMint = USDC_MINT;
                    fee.collectedAmount = feeRoute.outAmount;
                }
                collections.push(collection);
                routes.push(...collection.routes);
                instructions.push(...collection.instructions);
            }
            expected = BigInt(route.outAmount);
            minimum = leg.minOut;
            mint = output;
        }
        const decimals = assets.find(a => a.mint === mint)?.decimals ?? (mint === USDC_MINT ? 6 : 9);
        const previous = outputs.get(mint);
        outputs.set(mint, { mint, decimals, expected: (BigInt(previous?.expected ?? 0) + expected).toString(), minimum: (BigInt(previous?.minimum ?? 0) + minimum).toString() });
    }
    if (receive === "token" && output === NATIVE_SOL_MINT) {
        if (!payer.equals(wallet))
            throw new Error("Sponsored withdrawals cannot pay out native SOL");
        const ata = getAssociatedTokenAddressSync(new PublicKey(NATIVE_SOL_MINT), wallet);
        const info = await connection.getAccountInfo(ata, "confirmed");
        if (info && info.data.readBigUInt64LE(64) !== 0n)
            throw new Error("Move existing wrapped SOL before receiving native SOL");
        instructions.push(createCloseAccountInstruction(ata, wallet, wallet));
    }
    return { routes, instructions, collections, outputs: [...outputs.values()], priceImpactBps: impact, protocolFee: { bps: receive === "original" ? 0 : config.bps, wallet: config.wallet?.toBase58() ?? null, legs: fees } };
}
export type WithdrawBuildOptions = {
    /** Injected RPC connection; defaults to the host-configured `rpcConnection()`. */
    connection?: Connection;
    /** Sponsored mode: base58 fee payer that pays network fees and new-account rent and receives all recovered rent. */
    feePayer?: string;
};
export async function buildWithdraw(raw: WithdrawPrepareRequest, preview = false, options: WithdrawBuildOptions = {}): Promise<WithdrawPrepared> {
    const request = withdrawPrepareSchema.parse(raw), connection = options.connection ?? rpcConnection(), wallet = new PublicKey(request.wallet);
    if (raw.stage === "swap")
        return buildSwapStage(request, connection, preview);
    // Owner mode keeps payer === wallet: every instruction and message byte matches the single-payer engine.
    const payer = options.feePayer && options.feePayer !== request.wallet ? new PublicKey(options.feePayer) : wallet;
    const sponsored = !payer.equals(wallet);
    const state = await readSelectedPositionState(request.wallet, { positionMint: request.positionMint, inputMint: NATIVE_SOL_MINT, inputKind: "native" }, connection, true, { displayPrices: request.targetUSDC !== undefined });
    if (state.paused || state.frozen || state.transferFee || state.unsupportedExtensions.length)
        throw new Error("Position assets cannot be safely withdrawn");
    const full = state.pricing?.priceUsdA !== undefined && state.pricing?.priceUsdA !== null && state.pricing?.priceUsdB !== undefined && state.pricing?.priceUsdB !== null
        ? Number(state.currentAmounts.a) / 10 ** state.decimalsA * state.pricing.priceUsdA + Number(state.currentAmounts.b) / 10 ** state.decimalsB * state.pricing.priceUsdB : 0;
    const percentBps = request.percent !== undefined ? percentToBps(request.percent) : targetUSDCToBps(request.targetUSDC!, full);
    const removed = BigInt(state.liquidity) * BigInt(percentBps) / 10000n;
    if (removed <= 0n && percentBps !== 10000)
        throw new Error("Withdrawal amount is too small");
    const output = request.receive === "token" ? request.outputMint : USDC_MINT;
    if (!output || request.receive === "token" && ![NATIVE_SOL_MINT, state.mintA, state.mintB].includes(output))
        throw new Error("Choose SOL or a position token");
    const [positionInfo, poolInfo] = await connection.getMultipleAccountsInfo([new PublicKey(state.positionAccount), new PublicKey(state.poolId)], "confirmed");
    if (!positionInfo || !poolInfo)
        throw new Error("Position changed");
    const position = PersonalPositionLayout.decode(positionInfo.data), pool = PoolInfoLayout.decode(poolInfo.data);
    if (position.liquidity.toString() !== state.liquidity)
        throw new Error("Position changed");
    const rewards = pool.rewardInfos.filter(r => !r.mint.equals(PublicKey.default));
    const mintSlots = [pool.mintA, pool.mintB, ...rewards.map(r => r.mint)];
    const mints = [...new Map(mintSlots.map(m => [m.toBase58(), m])).values()];
    const infos = await connection.getMultipleAccountsInfo(mints, "confirmed");
    const assets: WithdrawAsset[] = mints.map((mint, i) => {
        const info = infos[i];
        if (!info || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(info.owner)))
            throw new Error("Unsupported reward asset");
        const decoded = unpackMint(mint, info, info.owner);
        if (i >= 2 && decoded.tlvData.length)
            throw new Error("Reward extensions require manual review");
        return { mint: mint.toBase58(), program: info.owner.toBase58(), decimals: decoded.decimals, account: getAssociatedTokenAddressSync(mint, wallet, false, info.owner).toBase58(), starting: "0", amount: "0" };
    });
    const recipients = assets.map(a => new PublicKey(a.account));
    const slotRecipients = mintSlots.map(m => recipients[mints.findIndex(k => k.equals(m))]!);
    const before = await connection.getMultipleAccountsInfoAndContext([wallet, new PublicKey(state.positionAccount), new PublicKey(state.nftAta), new PublicKey(state.positionMint), ...recipients], "confirmed");
    assets.forEach((a, i) => { const info = before.value[i + 4]; a.starting = info ? verifiedTokenAmount(info.data.toString("base64"), wallet, mints[i]!, info.owner.toBase58()).toString() : "0"; });
    const setup = assets.flatMap((a, i) => before.value[i + 4] ? [] : [createAssociatedTokenAccountIdempotentInstruction(payer, recipients[i]!, wallet, mints[i]!, new PublicKey(a.program))]);
    const minimumA = principalMinimum(BigInt(state.currentAmounts.a), percentBps, SLIPPAGE_BPS);
    const minimumB = principalMinimum(BigInt(state.currentAmounts.b), percentBps, SLIPPAGE_BPS);
    assets.forEach((a, i) => { a.minimum = (i === 0 ? minimumA : i === 1 ? minimumB : 0n).toString(); });
    const prefix = [atomicComputeUnitLimitInstruction(), ...setup, ...buildPositionExitInstructions({ owner: wallet, nftKey: new PublicKey(state.nftAta), positionKey: new PublicKey(state.positionAccount), nftProgram: new PublicKey(state.nftProgram), position, pool, recipients: slotRecipients, amount: new BN(removed.toString()), closePosition: percentBps === 10000, minimumA: new BN(minimumA.toString()), minimumB: new BN(minimumB.toString()) })];
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const commonTables = await openLookupTableReader(connection)([new PublicKey("AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU")]);
    const compile = (instructions: TransactionInstruction[]) => compileCompactOpenTransaction({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions }, commonTables).transaction;
    const first = compile(prefix);
    if (exceedsTxSizeLimit(versionedTransactionSize(first)))
        throw new Error("Position withdrawal exceeds transaction size limit");
    const simulated = await simulateAtContextSlot(() => connection.simulateTransaction(first, { sigVerify: false, replaceRecentBlockhash: true, minContextSlot: before.context.slot, accounts: { encoding: "base64", addresses: [wallet, new PublicKey(state.positionAccount), new PublicKey(state.nftAta), new PublicKey(state.positionMint), ...recipients].map(a => a.toBase58()) } }));
    if (simulated.value.err || !simulated.value.accounts)
        throw new Error(`Withdrawal simulation failed: ${JSON.stringify(simulated.value.err)}`);
    assets.forEach((a, i) => { const after = simulated.value.accounts![i + 4]; if (!after)
        throw new Error("Withdrawal recipient missing"); const delta = verifiedTokenAmount(after.data[0], wallet, mints[i]!, after.owner) - BigInt(a.starting); if (delta < 0n)
        throw new Error("Withdrawal consumed wallet inventory"); a.amount = delta.toString(); });
    const rentRefund = percentBps === 10000 ? [1, 2, 3].reduce((n, i) => n + BigInt(before.value[i]?.lamports ?? 0) - BigInt(simulated.value.accounts![i]?.lamports ?? 0), 0n) : 0n;
    // Sponsored: closing the position refunds its rent (personal position, NFT account, NFT mint) to the wallet;
    // send exactly that amount back to the sponsor that funded the open.
    const rentRecovery = sponsored && rentRefund > 0n ? [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: payer, lamports: rentRefund })] : [];
    const isolatedSources: IsolatedTokenAccount[] = [];
    const isolatedAssets = await Promise.all(assets.map(async (a, i) => {
        if (!shouldSwap(request.receive, a.mint, output) || BigInt(a.amount) === 0n)
            return a;
        const seed = randomBytes(16).toString("base64url"), program = new PublicKey(a.program);
        const address = await PublicKey.createWithSeed(wallet, seed, program);
        const space = getAccountLenForMint(unpackMint(mints[i]!, infos[i]!, program));
        const rentLamports = await connection.getMinimumBalanceForRentExemption(space, "confirmed");
        const source = { seed, address: address.toBase58(), mint: a.mint, program: a.program, space, rentLamports };
        isolatedSources.push(source);
        return { ...a, source: source.address };
    }));
    const isolatedRecipients = mintSlots.map(m => { const a = isolatedAssets.find(a => a.mint === m.toBase58())!; return new PublicKey(a.source ?? a.account); });
    const atomicPrefix = [atomicComputeUnitLimitInstruction(), ...setup.filter(ix => !isolatedAssets.some(a => a.source && ix.keys[1]?.pubkey.toBase58() === a.account)), ...isolatedSources.flatMap(a => createIsolatedTokenAccountInstructions(wallet, a, payer)), ...buildPositionExitInstructions({ owner: wallet, nftKey: new PublicKey(state.nftAta), positionKey: new PublicKey(state.positionAccount), nftProgram: new PublicKey(state.nftProgram), position, pool, recipients: isolatedRecipients, amount: new BN(removed.toString()), closePosition: percentBps === 10000, minimumA: new BN(minimumA.toString()), minimumB: new BN(minimumB.toString()) })];
    const swaps = await swapInstructions(connection, wallet, isolatedAssets, request.receive, output, state, payer);
    const tables = [...commonTables, ...await openLookupTableReader(connection)([...new Set(swaps.routes.flatMap(r => Object.keys(r.addressesByLookupTableAddress ?? {})))].map(k => new PublicKey(k)))];
    const combined = await compactAtaInstructions(connection, [...atomicPrefix, ...swaps.instructions, ...isolatedSources.map(a => createCloseAccountInstruction(new PublicKey(a.address), payer, wallet, [], new PublicKey(a.program))), ...rentRecovery]);
    const atomic = compileCompactOpenTransaction({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions: combined }, tables).transaction;
    const count = transactionCount(versionedTransactionSize(atomic), swaps.routes.length > 0);
    Object.assign(blockhash, await connection.getLatestBlockhash("confirmed"));
    const chosenInstructions = count === 2 ? [...prefix, ...rentRecovery] : combined;
    const compileFinal = (ixs: TransactionInstruction[]) => compileCompactOpenTransaction({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions: ixs }, count === 2 ? commonTables : tables).transaction;
    // Beam tips are paid by the wallet; sponsored transactions never carry one.
    const base = compileFinal(chosenInstructions), tip = sponsored ? null : await fetchBeamTipAddress();
    const chosen = chooseBeamTransaction(base, tip ? compileFinal([...chosenInstructions, beamTipInstruction(wallet, tip.address, tip.lamports)]) : null);
    const summary: WithdrawSummary = { operation: "withdraw", wallet: request.wallet, positionMint: request.positionMint, positionAccount: state.positionAccount, poolId: state.poolId, percentBps, receive: request.receive, outputMint: output, stage: count === 2 ? "withdraw" : "atomic", transactions: count, closesPosition: percentBps === 10000, startingLiquidity: state.liquidity, removedLiquidity: removed.toString(), assets, isolatedSources: count === 1 ? isolatedSources : [], outputs: swaps.outputs, priceImpactBps: swaps.priceImpactBps, protocolFee: swaps.protocolFee, ...impactFlags(swaps.priceImpactBps), slippageBps: SLIPPAGE_BPS, rentRefundLamports: rentRefund.toString(), maxSolDebitLamports: sponsored ? "0" : await solDebitBudget(connection, chosen.transaction, chosenInstructions), expiresAt: Date.now() + 60000, lastValidBlockHeight: blockhash.lastValidBlockHeight, blockhash: blockhash.blockhash, bytes: versionedTransactionSize(chosen.transaction), beam: { ...emptyBeamPlan(), enabled: !!tip, included: chosen.included, tipAddress: chosen.included ? tip!.address.toBase58() : null, tipLamports: chosen.included ? tip!.lamports : 0, skippedReason: chosen.skippedReason }, ...(sponsored ? { feePayer: payer.toBase58() } : {}) };
    if (!preview)
        assertImpactConfirmed(summary, request.confirmHighImpact);
    await simulateWithdraw(connection, chosen.transaction, summary);
    return preview ? { summary, unsignedTransaction: "", permit: "" } : prepareResult(chosen.transaction, summary);
}
function prepareResult(transaction: VersionedTransaction, summary: WithdrawSummary): WithdrawPrepared {
    const unsignedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    return { summary, unsignedTransaction, permit: withdrawPermit.issue(getSigningSecret(), { wallet: summary.wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary }) };
}
async function buildSwapStage(raw: WithdrawPrepareRequest, connection: Connection, preview = false): Promise<WithdrawPrepared> {
    const previous = raw.previous;
    if (!previous || !raw.tx1Signature)
        throw new Error("First transaction authorization and signature required");
    const { VersionedTransaction } = await import("@solana/web3.js");
    const first = VersionedTransaction.deserialize(Buffer.from(previous.unsignedTransaction, "base64"));
    const original = previous.summary;
    if (!withdrawPermit.verify(getSigningSecret(), { wallet: raw.wallet, message: Buffer.from(first.message.serialize()).toString("base64"), summary: original }, previous.permit) || original.wallet !== raw.wallet || original.positionMint !== raw.positionMint || original.stage !== "withdraw")
        throw new Error("Invalid first transaction authorization");
    const receipt = await connection.getTransaction(raw.tx1Signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    // Permit stays bound to the prepared first-stage message. The landed tx may
    // be Phantom-rewritten (Lighthouse / ComputeBudget / recompile / ALTs).
    if (!landedTransactionMatchesPrepared(first, receipt, raw.wallet) || !receipt?.meta)
        throw new Error("First transaction must be finalized and match the prepared withdrawal");
    const keys = receipt.transaction.message.getAccountKeys({ accountKeysFromLookups: receipt.meta.loadedAddresses });
    const assets = original.assets.map(a => {
        const index = Array.from({ length: keys.length }, (_, i) => keys.get(i)?.toBase58()).indexOf(a.account);
        const amount = (rows: typeof receipt.meta.preTokenBalances) => BigInt(rows?.find(b => b.accountIndex === index && b.mint === a.mint && b.owner === raw.wallet)?.uiTokenAmount.amount ?? "0");
        const received = amount(receipt.meta!.postTokenBalances) - amount(receipt.meta!.preTokenBalances);
        if (index < 0)
            throw new Error("Withdrawal token account absent from receipt");
        const cap = capReceivedAmount(received, BigInt(a.amount), BigInt(a.minimum ?? a.amount));
        return { ...a, starting: (BigInt(a.starting) + received).toString(), amount: cap.toString(), minimum: cap.toString() };
    });
    const wallet = new PublicKey(raw.wallet);
    // The swap stage keeps the fee payer bound (by permit) into the first stage's summary.
    const payer = original.feePayer ? new PublicKey(original.feePayer) : wallet;
    const sponsored = !payer.equals(wallet);
    const swaps = await swapInstructions(connection, wallet, assets, original.receive, original.outputMint!, { poolId: original.poolId, mintA: assets[0]!.mint, mintB: assets[1]!.mint }, payer);
    if (!preview)
        assertImpactConfirmed(impactFlags(swaps.priceImpactBps), raw.confirmHighImpact);
    const blockhash = await connection.getLatestBlockhash("confirmed");
    const tables = await openLookupTableReader(connection)([...new Set(swaps.routes.flatMap(r => Object.keys(r.addressesByLookupTableAddress ?? {})))].map(k => new PublicKey(k)));
    let instructions = await compactAtaInstructions(connection, [atomicComputeUnitLimitInstruction(), ...swaps.instructions]);
    const compile = (ixs: TransactionInstruction[]) => compileCompactOpenTransaction({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions: ixs }, tables).transaction;
    const tip = sponsored ? null : await fetchBeamTipAddress();
    const fitted = await fitFeeCollections(connection, swaps.collections, instructions, compile, tip ? beamTipInstruction(wallet, tip.address, tip.lamports) : undefined);
    instructions = fitted.instructions;
    if (fitted.fallback)
        for (const fee of swaps.protocolFee.legs) {
            delete fee.collectedMint;
            delete fee.collectedAmount;
        }
    const base = compile(instructions);
    if (exceedsTxSizeLimit(versionedTransactionSize(base)))
        throw new Error("Swap stage exceeds transaction size limit; received tokens remain in wallet");
    const chosen = chooseBeamTransaction(base, tip ? compile([...instructions, beamTipInstruction(wallet, tip.address, tip.lamports)]) : null);
    const summary: WithdrawSummary = { ...original, stage: "swap", maxSolDebitLamports: sponsored ? "0" : await solDebitBudget(connection, chosen.transaction, instructions), assets, outputs: swaps.outputs, protocolFee: swaps.protocolFee, priceImpactBps: swaps.priceImpactBps, ...impactFlags(swaps.priceImpactBps), tx1Signature: raw.tx1Signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, expiresAt: Date.now() + 60000, bytes: versionedTransactionSize(chosen.transaction), beam: { ...emptyBeamPlan(), enabled: !!tip, included: chosen.included, tipAddress: chosen.included ? tip!.address.toBase58() : null, tipLamports: chosen.included ? tip!.lamports : 0, skippedReason: chosen.skippedReason } };
    await simulateWithdraw(connection, chosen.transaction, summary);
    return preview ? { summary, unsignedTransaction: "", permit: "" } : prepareResult(chosen.transaction, summary);
}
async function solDebitBudget(connection: Connection, transaction: VersionedTransaction, instructions: TransactionInstruction[]) {
    const network = await estimateFeeForMessage(connection, transaction.message, "confirmed", {
        fallback: defaultRpcConnection, emptyError: WITHDRAW_FEE_ESTIMATE_MESSAGE,
    });
    // Each retained ATA creation is budgeted conservatively, including Token-2022.
    const ataCreates = instructions.filter(ix => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").length;
    const rent = await connection.getMinimumBalanceForRentExemption(512, "confirmed");
    return (BigInt(network) + BigInt(ataCreates) * BigInt(rent) + BigInt(BEAM_MIN_TIP_LAMPORTS)).toString();
}

