/* eslint-disable no-console -- CLI transaction reports are the intended output. */
/**
 * Mainnet harness: node_modules/.bin/tsx scripts/live-fee-test.ts <command> [options]
 * Dry-run signs locally for exact wire measurement; only --send permits broadcasting.
 * Examples: pairs; open --pair SPCX --deposit usdc --amount 1;
 * add --position NFT --deposit token --amount 0.001; compound --position NFT;
 * swap --from usdc --to MINT --amount 1; withdraw --position NFT --percent 100 --receive usdc.
 * Options: --url URL, --keypair FILE, --mint MINT (choose pool token), --send.
 * Loads .env.local without overriding existing environment. Server env is separate.
 * Beam caveat: this branch's isBeamEnabled requires SOLAMI_API_KEY even with
 * SOLAMI_BEAM=true. There is currently NO keyless force-tip/RPC configuration.
 * For production tip sizes, configure a real SOLAMI_API_KEY on the dev server,
 * enable SOLAMI_BEAM and restart it. To support keyless tips with RPC broadcast,
 * isBeamEnabled would need to explicitly accept true/1/on; then restart the server
 * with SOLAMI_BEAM=true and SOLANA_RPC_URL. This harness never adds tips itself:
 * that would invalidate the app permit. Oversize tips may be omitted by the app.
 * Frontend open/add/compound use prepare permits, not /verify-sign-token (the
 * latter belongs to the separate MCP signing flow). Exit preview cannot execute.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { parseTokenAmount } from "../src/lib/amount";
import { USDC_MINT, NATIVE_SOL_MINT } from "../src/lib/ids";
import { jupiterHeaders, jupiterUrl } from "../src/lib/jupiter/urls";
import type { WalletDiscovery } from "../src/lib/wallet-discovery";
import type { DiscoverRwaPairsResult, RwaPairRow } from "../src/lib/rwa-pairs";
import type { OpenPositionSummary } from "../src/lib/open-types";
import type { CompoundSummary } from "../src/lib/compound-types";
import type { WithdrawPrepared, WithdrawRequest } from "../src/lib/withdraw/types";
import type { SelectedQuote } from "../src/lib/selected-quote";

if (existsSync(".env.local")) loadEnvFile(".env.local");
const args = process.argv.slice(2);
const command = args.shift();
const options = new Map<string, string>();
let send = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--send") { send = true; continue; }
  if (!/^--(?:pair|position|deposit|amount|from|to|url|keypair|mint|percent|receive)$/.test(arg) || !args[i + 1] || args[i + 1]!.startsWith("--")) {
    throw new Error(`Unknown option or missing value: ${arg}`);
  }
  options.set(arg.slice(2), args[++i]!);
}
function required(name: string) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
const base = options.get("url") ?? "http://localhost:3999";
const feeWallet = new PublicKey(process.env.SOFINANCE_FEE_WALLET ?? "CS5CWYhPUrovyRwk4wfyWHdtQHChKUFd65RAZAVkN1AK");
const keypairPath = resolve(options.get("keypair") ?? "/home/box/sofinance-test-wallet-keypair.json");
const keypair = existsSync(keypairPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[])) : null;
const wallet = keypair?.publicKey.toBase58() ?? "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb";
if (!options.has("keypair") && wallet !== "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb") throw new Error("Unexpected test wallet");
if (!process.env.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is required (.env.local or environment)");
const rpc = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
let lastRequest = 0;
async function request<T>(url: string, body?: unknown, broadcast = false): Promise<T> {
  if (broadcast && !send) throw new Error("Broadcast blocked in dry-run");
  for (let attempt = 0; attempt < 6; attempt++) {
    await wait(Math.max(0, 2100 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(new URL(url).hostname.endsWith("jup.ag") ? jupiterHeaders() : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: non-JSON response`); }
    // Never retry a broadcast: an HTTP error can follow an accepted transaction.
    if (!broadcast && attempt < 5 && (response.status === 429 || data.code === "jupiter_rate_limited")) {
      const header = response.headers.get("retry-after");
      const retry = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
      const delay = Math.max(2100 * 2 ** attempt, retry || 0, Number(data.retryAfterMs) || 0);
      console.log(`Rate limited; retrying preparation/read in ${delay}ms`);
      await wait(delay); continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error ?? text}`);
    return data as T;
  }
  throw new Error("Retry budget exhausted");
}
const api = <T>(path: string, body?: unknown, broadcast = false) => request<T>(new URL(`/api/${path}`, base).toString(), body, broadcast);
type Beam = { tipAddress: string | null; included: boolean; skippedReason: string | null };
type Prepared<S> = { unsignedTransaction: string; permit: string; summary: S };
type SelectedPrepared = {
  unsignedTransaction: string; permit: string; quote: SelectedQuote; simulated: boolean;
  expiresAt: number; blockhash: string; lastValidBlockHeight: number;
  startingLiquidity: string; startingBalances: { input: string; a: string; b: string }; beam?: Beam;
};
type Fee = { mint: string; amount: string; destination: string };
async function inspect(encoded: string, beam?: Beam) {
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  if (tx.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("Prepared transaction payer mismatch");
  const message = Buffer.from(tx.message.serialize());
  if (!keypair) throw new Error(`Keypair file missing: ${keypairPath}; signed size verification requires it`);
  tx.sign([keypair]); // Preserves the app's NFT mint partial signature.
  if (!Buffer.from(tx.message.serialize()).equals(message)) throw new Error("Message changed during signing");
  if (tx.signatures.some((sig) => sig.every((byte) => byte === 0))) throw new Error("Missing required signature");
  const tables = await Promise.all(tx.message.addressTableLookups.map(async (lookup) => {
    const table = (await rpc.getAddressLookupTable(lookup.accountKey)).value;
    if (!table) throw new Error(`Missing lookup table ${lookup.accountKey}`);
    return table;
  }));
  const instructions = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions;
  const fees: Fee[] = [];
  const systemTransfers: { destination: string; amount: string }[] = [];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data);
    if (ix.programId.equals(SystemProgram.programId) && data.length === 12 && data.readUInt32LE(0) === 2) {
      const transfer = { destination: ix.keys[1]!.pubkey.toBase58(), amount: data.readBigUInt64LE(4).toString() };
      systemTransfers.push(transfer);
      if (transfer.destination === feeWallet.toBase58()) fees.push({ mint: "SOL", ...transfer });
    }
    const feeAta=getAssociatedTokenAddressSync(new PublicKey(USDC_MINT),feeWallet,true);
    if(ix.programId.toBase58()==="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" && ix.keys.some(key=>key.pubkey.equals(feeAta) && key.isWritable))fees.push({mint:USDC_MINT,amount:"Jupiter platform fee (see prepared summary)",destination:feeAta.toBase58()});
    if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(ix.programId.toBase58())) continue;
    if (data[0] === 12 && data.length === 10) {
      const mint = ix.keys[1]!.pubkey;
      const destination = ix.keys[2]!.pubkey;
      if (destination.equals(getAssociatedTokenAddressSync(mint, feeWallet, true, ix.programId))) {
        fees.push({ mint: mint.toBase58(), amount: data.readBigUInt64LE(1).toString(), destination: destination.toBase58() });
      }
    } else if (data[0] === 3 && data.length === 9) {
      // Unchecked transfer: resolve existing recipient token account on chain.
      const destination = ix.keys[1]!.pubkey;
      const info = await rpc.getAccountInfo(destination);
      if (info) {
        const account = unpackAccount(destination, info, ix.programId);
        if (account.owner.equals(feeWallet)) fees.push({ mint: account.mint.toBase58(), amount: data.readBigUInt64LE(1).toString(), destination: destination.toBase58() });
      }
    }
  }
  let tips: string[] = beam?.tipAddress ? [beam.tipAddress] : [];
  if (!tips.length && systemTransfers.length) {
    tips = await request<string[]>("https://api.solami.dev/onchain/tip-addresses");
  }
  const tipInstructions = systemTransfers.filter((ix) => tips.includes(ix.destination));
  const wire = tx.serialize();
  console.log(JSON.stringify({ transaction: 1, signedBytes: wire.length, "fits<=1232": wire.length <= 1232,
    beamTipIxPresent: tipInstructions.length > 0, beamTipInstructions: tipInstructions, beamPlan: beam ?? null,
    detectedFees: fees.length ? fees : "none (amount 0; no fee instruction)", }, null, 2));
  return { tx, wire, fees, signature: bs58.encode(tx.signatures[0]!) };
}
async function balances(mints: string[]) {
  const result = new Map<string, { amount: bigint; ataExisted: boolean; ata: string }>();
  for (const mint of [...new Set([USDC_MINT, ...mints])].filter((mint) => mint !== "SOL")) {
    const key = new PublicKey(mint);
    const mintInfo = await rpc.getAccountInfo(key);
    if (!mintInfo) throw new Error(`Mint not found: ${mint}`);
    const ata = getAssociatedTokenAddressSync(key, feeWallet, true, mintInfo.owner);
    const [info, accounts] = await Promise.all([rpc.getAccountInfo(ata), rpc.getParsedTokenAccountsByOwner(feeWallet, { mint: key })]);
    const amount = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n);
    result.set(mint, { amount, ataExisted: info !== null, ata: ata.toBase58() });
  }
  return result;
}
async function execute(encoded: string, validity: { expiresAt?: number; lastValidBlockHeight: number }, mints: string[],
  broadcast: (signedTransaction: string) => Promise<{ signature: string }>, confirm?: (signature: string) => Promise<void>, beam?: Beam) {
  if (!keypair) {
    console.log(JSON.stringify({ preparedBytesUnsigned: Buffer.from(encoded, "base64").length,
      signedSizeVerified: false, beamPlan: beam ?? null }, null, 2));
  }
  const measured = await inspect(encoded, beam);
  if (!send) { console.log("Dry-run: prepared and signed locally; no transaction broadcast."); return; }
  if (measured.wire.length > 1232) throw new Error("Transaction exceeds 1232 bytes");
  const before = await balances([...mints, ...measured.fees.map((fee) => fee.mint)]);
  if (validity.expiresAt && Date.now() >= validity.expiresAt) throw new Error("Prepared permit expired; rerun preparation");
  console.log(`Submitting ${measured.signature}\nhttps://solscan.io/tx/${measured.signature}`);
  try {
    const sent = await broadcast(Buffer.from(measured.wire).toString("base64"));
    if (sent.signature !== measured.signature) throw new Error("Broadcast signature mismatch");
    // Without Beam or priority fees the app's single RPC send may be dropped. Rebroadcast the
    // identical signed bytes (same signature, cannot double-execute) until confirmed or expired.
    let landed = false;
    const rebroadcast = (async () => {
      while (!landed && await rpc.getBlockHeight("confirmed").catch(() => 0) <= validity.lastValidBlockHeight) {
        await rpc.sendRawTransaction(measured.wire, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
        await wait(2000);
      }
    })();
    const result = await rpc.confirmTransaction({ signature: measured.signature, blockhash: measured.tx.message.recentBlockhash,
      lastValidBlockHeight: validity.lastValidBlockHeight }, "finalized").finally(() => { landed = true; });
    await rebroadcast;
    if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
    console.log(`Finalized: ${sent.signature}\nhttps://solscan.io/tx/${sent.signature}`);
    if (confirm) await confirm(sent.signature);
  } finally {
    const after = await balances([...before.keys()]);
    for (const [mint, pre] of before) console.log(JSON.stringify({ feeWallet: feeWallet.toBase58(), mint,
      ata: pre.ata, ataExistedBefore: pre.ataExisted, preRaw: pre.amount.toString(), postRaw: after.get(mint)!.amount.toString(),
      deltaRaw: (after.get(mint)!.amount - pre.amount).toString() }));
  }
}
async function poll(path: string, body: unknown) {
  for (let i = 0; i < 30; i++) {
    const result = await api<{ status: string }>(path, body);
    console.log(`${path}: ${result.status}`);
    if (result.status !== "pending") {
      if (!["success", "finalized"].includes(result.status)) throw new Error(`App verification: ${result.status}`);
      return;
    }
    await wait(2000);
  }
  throw new Error("App verification remains pending; check signature before retrying");
}
function matches(pair: { symbolA: string | null; symbolB: string | null }, name: string) {
  const symbols = [pair.symbolA?.toUpperCase(), pair.symbolB?.toUpperCase()];
  return symbols.includes(name) && symbols.includes(`${name}X`);
}
function tokenMint(pair: Pick<RwaPairRow, "mintA" | "mintB" | "symbolA" | "symbolB">) {
  const mint = options.get("mint") ?? (pair.symbolA.toUpperCase() === `${pair.symbolB.toUpperCase()}X` ? pair.mintB : pair.mintA);
  if (![pair.mintA, pair.mintB].includes(mint)) throw new Error("--mint must be one of the pool mints");
  return mint;
}
async function main() {
  console.log(`Wallet: ${wallet}; mode: ${send ? "SEND" : "DRY-RUN"}; app: ${base}`);
  if (command === "withdraw") {
    const receive = options.get("receive") ?? "usdc";
    if (!["usdc", "original", "token"].includes(receive)) throw new Error("--receive must be usdc, original, or token");
    const input: WithdrawRequest = { wallet, positionMint: required("position"), percent: Number(required("percent")),
      receive: receive as WithdrawRequest["receive"], ...(receive === "token" ? {outputMint: required("mint")} : {}) };
    let prepared = await api<WithdrawPrepared>("withdraw-prepare", input);
    console.log(JSON.stringify(prepared.summary, null, 2));
    const initialSol = await rpc.getBalance(new PublicKey(wallet), "finalized");
    for (let step = 1; step <= 2; step++) {
      console.log(`Withdrawal step ${step} of ${prepared.summary.transactions}`);
      let finalizedSignature = "";
      const current = prepared;
      await execute(current.unsignedTransaction, current.summary, current.summary.assets.map(a => a.mint),
        signedTransaction => api("withdraw-broadcast", {wallet, signedTransaction, permit:current.permit, summary:current.summary}, true),
        async signature => { finalizedSignature = signature; await poll("withdraw-status", {signature,prepared:current}); }, current.summary.beam);
      if (!send) {
        if (current.summary.stage === "withdraw") console.log("Dry-run: step 2 requires an actual finalized step 1; no conversion transaction prepared.");
        break;
      }
      if (current.summary.stage !== "withdraw") break;
      prepared = await api<WithdrawPrepared>("withdraw-prepare", {...input, stage:"swap", tx1Signature:finalizedSignature, previous:current});
    }
    const finalSol = await rpc.getBalance(new PublicKey(wallet), "finalized");
    console.log(JSON.stringify({wallet, walletSOLLamportsDelta:String(finalSol-initialSol), rentRefundLamports:prepared.summary.rentRefundLamports}));
    return;
  }
  if (command === "exit") { required("position"); console.log("Exit conversion not implemented: only /api/lp-decision/exit-preview exists."); return; }
  if (command === "pairs" || command === "open") {
    const discovered = await api<DiscoverRwaPairsResult>("rwa-pairs");
    const pairs = discovered.pairs.filter((pair) => ["SPCX", "MSTR"].some((name) => matches(pair, name)));
    if (command === "pairs") {
      const owned = await api<WalletDiscovery>(`wallet?wallet=${wallet}`);
      console.log(JSON.stringify({ pools: pairs, positions: owned.positions.filter((p) => pairs.some((pair) => pair.poolAddress === p.poolId) || ["SPCX", "MSTR"].some((name) => matches(p, name))) }, null, 2)); return;
    }
    const name = required("pair").toUpperCase();
    const candidates = pairs.filter((pair) => matches(pair, name) || pair.poolAddress === required("pair"));
    if (!candidates.length) throw new Error(`No pool found for ${name}`);
    const pair = candidates[0]!;
    console.log(`Selected pool ${pair.poolAddress} (${pair.symbolA}/${pair.symbolB}); first in app discovery order. Use --pair POOL_ADDRESS to select another.`);
    const deposit = required("deposit");
    if (!["usdc", "sol", "token"].includes(deposit)) throw new Error("Invalid open deposit");
    const inputMint = deposit === "usdc" ? USDC_MINT : deposit === "sol" ? NATIVE_SOL_MINT : tokenMint(pair);
    const body = { wallet, poolId: pair.poolAddress, inputMint, inputKind: deposit === "sol" ? "native" : "token", amount: required("amount"), rangePreset: "standard", minPrice: "", maxPrice: "" };
    const quote = await api<unknown>("open-quote", body);
    console.log("open-quote:", JSON.stringify(quote));
    const prepared = await api<Prepared<OpenPositionSummary>>("open-prepare", body);
    await execute(prepared.unsignedTransaction, prepared.summary, [inputMint, pair.mintA, pair.mintB],
      (signedTransaction) => api("open-broadcast", { wallet, signedTransaction, permit: prepared.permit, summary: prepared.summary }, true),
      (signature) => poll("transaction-finality", { signature, lastValidBlockHeight: prepared.summary.lastValidBlockHeight }), prepared.summary.beam);
  } else if (command === "add") {
    const positionMint = required("position");
    const owned = await api<WalletDiscovery>(`wallet?wallet=${wallet}`);
    const position = owned.positions.find((p) => p.positionMint === positionMint);
    if (!position) throw new Error("Position NFT not found in wallet");
    const deposit = required("deposit");
    if (!["usdc", "token"].includes(deposit)) throw new Error("Add deposit must be usdc or token");
    const inputMint = deposit === "usdc" ? USDC_MINT : tokenMint({ ...position, symbolA: position.symbolA ?? "", symbolB: position.symbolB ?? "" });
    const selection = { positionMint, inputMint, inputKind: "token" };
    await api(`selected-state?${new URLSearchParams({ wallet, ...selection })}`);
    const body = { wallet, ...selection, amount: required("amount"), floorBps: 9900, toleranceBps: 100 };
    console.log("selected-quote:", JSON.stringify(await api("selected-quote", body)));
    // Frontend prepares directly; /selected-preflight is an optional duplicate
    // simulation and is intentionally not called (prepare itself simulates).
    const p = await api<SelectedPrepared>("selected-prepare", body);
    if (!p.simulated) throw new Error("App did not simulate add");
    const common = { wallet, selection, requested: p.quote.requested, floorBps: p.quote.floorBps,
      expiresAt: p.expiresAt, lastValidBlockHeight: p.lastValidBlockHeight, startingLiquidity: p.startingLiquidity,
      expectedLiquidity: p.quote.liquidity, rangeSide: p.quote.rangeSide, startingBalances: p.startingBalances };
    await execute(p.unsignedTransaction, p, [inputMint, position.mintA, position.mintB],
      (signedTransaction) => api("selected-broadcast", { ...common, signedTransaction, permit: p.permit }, true),
      (signature) => poll("selected-status", { ...common, signature, poolId: p.quote.poolId, positionAccount: p.quote.positionAccount }), p.beam);
  } else if (command === "compound") {
    const positionMint = required("position");
    await api("compound-state", { wallet, positionMint });
    const p = await api<Prepared<CompoundSummary>>("compound-prepare", { wallet, positionMint, sourceSignatures: [] });
    await execute(p.unsignedTransaction, p.summary, [p.summary.state.mintA, p.summary.state.mintB, ...p.summary.state.rewards.map((r) => r.mint)],
      (signedTransaction) => api("compound-broadcast", { wallet, positionMint, summary: p.summary, permit: p.permit, signedTransaction }, true),
      (signature) => poll("compound-confirm", { wallet, attempt: { version: 1, kind: "compound", wallet, positionMint, signature, createdAt: Date.now(), summary: p.summary } }), p.summary.beam);
  } else if (command === "swap") {
    if (required("from") !== "usdc") throw new Error("Swap helper only accepts --from usdc");
    const outputMint = new PublicKey(required("to")).toBase58();
    const quote = await request(jupiterUrl("/swap/v1/quote", { inputMint: USDC_MINT, outputMint, amount: parseTokenAmount(required("amount"), 6).toString(), slippageBps: 50, instructionVersion: "V2", maxAccounts: 20 }).toString());
    const p = await request<{ swapTransaction: string; lastValidBlockHeight: number }>(jupiterUrl("/swap/v1/swap").toString(),
      { userPublicKey: wallet, quoteResponse: quote, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true });
    await execute(p.swapTransaction, p, [USDC_MINT, outputMint], async (signedTransaction) => {
      if (!send) throw new Error("Swap broadcast blocked");
      return { signature: await rpc.sendRawTransaction(Buffer.from(signedTransaction, "base64"), { skipPreflight: false, maxRetries: 3 }) };
    });
  } else throw new Error("Usage: live-fee-test.ts pairs|open|add|compound|exit|swap [options] [--send]");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
