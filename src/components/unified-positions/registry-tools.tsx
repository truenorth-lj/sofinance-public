"use client";

/**
 * Tool panels (Add / Withdraw / Claim fees, PR7; Compound, PR8; Performance, PR9 in `registry-performance.tsx`) for "My positions" rows served through the DEX registry.
 * Everything here is decided from the registry: the descriptor's capabilities and meta (withdraw outputs, partial
 * withdraw, claim, compound, deposit inputs, fee policy, rent model). No layer here knows which DEX a position belongs to.
 *
 * Every send goes through the shared tx pipeline (`useTxPipeline` + `dexTxAdapter`): wallet signAndSend, loading →
 * success / failure with a Solscan link, balances refresh; the pipeline's success notice stays until dismissed.
 */
import { CircleAlert, LoaderCircle, Sprout } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { DEPOSIT_MINIMUM_UNAVAILABLE, depositTooSmallMessage, dexTxAdapter, fetchAddQuote, type AddQuote, type DexCapabilities, type DexPreparedStep, type DexDescriptor, type DexStepInput, type DexStepOp, type FeeRule, type RentQuote } from "@/lib/dex/client";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { CANCEL_CHECK_PENDING_COPY, CHECKING_SOLANA_COPY, solscanTxUrl, TX_WAITING_PREVIOUS_EXPIRY_COPY, txInterruptionMessage, type TxInterruption } from "@/lib/tx-pipeline";
import type { ToolId, TokenRef, UnifiedPosition, WithdrawOutput } from "@/lib/unified-positions/model";
import { useTxPipeline } from "../transactions/use-tx-pipeline";
import { useWalletConnection } from "../wallet-connection";
import { useTxWallet } from "../use-tx-wallet";
import { RegistryPerformancePanel } from "./registry-performance";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { beginPositionOp, trackPositionSignature, usePositionOpLock } from "./position-op-lock";
import { CompoundSuccessHalo, useCompoundSuccessHalo } from "../compound-halo";

/** A wallet balance the Add panel can check against (raw atomic string). */
export type ToolBalance = { balance: string; decimals: number };

export type RegistryToolProps = {
  position: UnifiedPosition;
  descriptor: DexDescriptor;
  capabilities: DexCapabilities;
  view: ToolId;
  showStockPerformance?: boolean;
  /** Wallet balances by token id; a missing entry means "not read" (the server still checks). */
  balances: Readonly<Record<string, ToolBalance | undefined>>;
  symbolOf: (token: TokenRef) => string;
  /** A send of this position landed: re-read positions and balances. */
  onConfirmed: () => void;
  /** The Performance tab read this position (report null on failure), so the all-stocks overview need not read it again. */
  onPerformance?: (key: string, result: { report: PositionPerformanceReport | null; error: boolean }) => void;
};

const CARD = "mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8";
/** The Raydium Compound fees panel's button (compound-panel.tsx), so both DEXes' compound looks the same. */
const COMPOUND_BUTTON = "inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3.5 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-48";
export const BUTTON = "mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-cream/40 disabled:hover:bg-white/10";
export const FIELD = "w-full rounded-inset border border-white/20 bg-white/10 px-4 py-3 text-base font-semibold text-cream outline-none focus:border-white/40 disabled:opacity-60 sm:text-sm";
export const LABEL = "mt-5 block text-xs font-medium uppercase tracking-[0.16em] text-smoke";
const LAMPORTS_PER_SOL = 1_000_000_000;

export function RegistryPositionTool(props: RegistryToolProps) {
  if (props.view === "performance" && props.capabilities.performance.supported) return <RegistryPerformancePanel {...props} />;
  if (props.view === "deposit" && props.capabilities.deposit.supported) return <RegistryAddPanel {...props} />;
  if (props.view === "compound" && props.capabilities.compound.supported) return <RegistryCompoundPanel {...props} />;
  if (props.view === "withdraw" && props.capabilities.withdraw.supported) return <>
    <RegistryWithdrawPanel {...props} />
    {props.capabilities.claim.supported ? <RegistryClaimPanel {...props} /> : null}
    <ExitPreviewUnavailable capabilities={props.capabilities} />
  </>;
  return null;
}

/** The exit estimate belongs to the Withdraw tool; greyed with the descriptor's reason until a DEX supports it. */
function ExitPreviewUnavailable({ capabilities }: { capabilities: DexCapabilities }) {
  const exitPreview = capabilities.exitPreview;
  if (exitPreview.supported) return null;
  return <div aria-disabled="true" data-testid="exit-preview-unavailable" className="mt-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4 opacity-60">
    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-smoke">Exit estimate</h4>
    <p className="mt-1 text-xs leading-5 text-smoke">{exitPreview.reason}</p>
  </div>;
}

/** "0.1% fee on the part we swap" etc., from the descriptor's fee rule (no DEX knowledge). */
export function feeLine(rule: FeeRule, swapNoun: string): string {
  if (rule.kind === "none") return "No platform fee.";
  const percent = `${rule.bps / 100}%`;
  const swapped = swapNoun ? `the part we swap ${swapNoun}` : "the part we swap";
  if (rule.kind === "swap-input-bps") return `A ${percent} platform fee applies only to ${swapped}; nothing is charged on the rest.`;
  if (rule.kind === "swap-output-bps") return `A ${percent} platform fee applies only to the swapped output.`;
  return `A ${percent} platform fee applies to the harvested fees.`;
}

/** The rent line shown before a full withdraw is signed. */
function closeRentLine(position: UnifiedPosition, descriptor: DexDescriptor): string | null {
  const rent = descriptor.meta.rent;
  if (!rent?.refundableOnClose) return null;
  if (position.closeRefundLamports && /^\d+$/.test(position.closeRefundLamports)) {
    const sol = Number(position.closeRefundLamports) / LAMPORTS_PER_SOL;
    return `Withdrawing 100% closes the position. Its rent, about ${sol.toFixed(4)} SOL, comes back to your wallet.`;
  }
  return "Withdrawing 100% closes the position. Its rent comes back to your wallet.";
}

/** The line shown before a partial withdraw when the DEX leaves the unclaimed fees in the position (capability only). */
function partialWithdrawFeesLine(capabilities: DexCapabilities): string | null {
  if (!capabilities.withdraw.supported || !capabilities.withdraw.partial || !capabilities.withdraw.partialLeavesFees) return null;
  return capabilities.claim.supported ? "Unclaimed fees stay in the position. Use Claim fees below." : "Unclaimed fees stay in the position.";
}

/** "This also creates your SPCX token account: about 0.0020 SOL rent…" for the accounts a prepared step creates. */
export function tokenAccountRentLine(created: DexPreparedStep["result"]["createsTokenAccounts"], symbolFor: (mint: string) => string): string | null {
  if (!created?.length) return null;
  const lamports = created.reduce((sum, item) => sum + (/^\d+$/.test(item.rentLamports) ? Number(item.rentLamports) : 0), 0);
  const names = created.map((item) => symbolFor(item.mint)).join(" and ");
  const noun = created.length === 1 ? "token account" : "token accounts";
  return `This also creates your ${names} ${noun} in your wallet: about ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL rent, which comes back if you close ${created.length === 1 ? "that account" : "them"}.`;
}

const lamportsOf = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);
const solText = (lamports: bigint) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);

/**
 * An open quote's rent as separate lines (PR9.2): the position rent, refunded when the position closes, and the rent of
 * new wallet token accounts, which is not (it stays in the token account). `totalLamports` is the sum the setup step's
 * SOL safety check caps the simulation at (plus network fees).
 */
export function openRentLines(rent: RentQuote | null | undefined): { lines: string[]; totalLamports: bigint } {
  if (!rent) return { lines: [], totalLamports: 0n };
  const position = lamportsOf(rent.refundableLamports);
  const tokenAccounts = lamportsOf(rent.tokenAccountLamports);
  const spent = lamportsOf(rent.nonRefundableLamports);
  const lines = [`Position rent: about ${solText(position)} SOL, refunded when you close the position.`];
  if (tokenAccounts > 0n) lines.push(`New token-account rent: about ${solText(tokenAccounts)} SOL. Stays in your token account; refundable only if you close that account.`);
  if (spent > 0n) lines.push(`Shared account rent: about ${solText(spent)} SOL, not refunded.`);
  return { lines, totalLamports: position + tokenAccounts + spent };
}

/**
 * One send per panel through the shared pipeline, scoped to this position; a multi-step plan runs through
 * `useTxPipeline().runSteps`, which waits for each step to confirm before preparing the next. Every
 * op on the same position shares one lock (`position-op-lock`): while any of them is preparing, in the wallet, being
 * checked or confirming, all panels of that position are locked, and a tab switch does not release it.
 */
function usePositionTx<Op extends DexStepOp>(op: Op, position: UnifiedPosition, onConfirmed: () => void) {
  const { address: wallet } = useWalletConnection();
  const txWallet = useTxWallet();
  const adapter = useMemo(() => dexTxAdapter(op), [op]);
  // Errors show inline under the panel's button (with Try again), so no failure toast covers that button at 375 px.
  const tx = useTxPipeline(adapter, txWallet, { scope: position.key, inlineErrors: true });
  const shared = usePositionOpLock(position.key);
  const [prepared, setPrepared] = useState<DexPreparedStep["result"] | null>(null);
  const relayStore = useRef(createJupiterRelayStore());
  const confirmed = useRef<string | null>(null);
  const settled = tx.status === "success" ? tx.signature ?? "" : null;
  const latestConfirmed = useRef(onConfirmed);
  useEffect(() => { latestConfirmed.current = onConfirmed; });
  useEffect(() => {
    if (settled === null || confirmed.current === settled) return;
    confirmed.current = settled;
    latestConfirmed.current();
  }, [settled]);
  const send = async (fields: Omit<DexStepInput<Op>, "context" | "relayStore" | "beforeWallet">) => {
    const release = beginPositionOp(position.key);
    if (!release) return; // another op on this position is in flight (the panel is greyed; this closes the race)
    const inputFor = (step: number, priorSignatures: string[], planToken?: string) => ({ ...fields, relayStore: relayStore.current, beforeWallet: setPrepared,
      context: { step, priorSignatures, ...(planToken ? { planToken } : {}) } }) as unknown as DexStepInput<Op>;
    setPrepared(null);
    try {
      // The pipeline prepares each next step only once the previous one is confirmed, and reports a stop in plain words.
      await tx.runSteps(inputFor(1, []), {
        progress: (step) => ({ step: step.result.step, of: step.result.of }),
        next: (sent, earlier) => {
          trackPositionSignature(position.key, sent.signature);
          setPrepared(null);
          const { done, step, planToken } = sent.prepared.result;
          return done ? null : inputFor(step + 1, [...earlier, sent].map((item) => item.signature), planToken);
        },
      });
    } finally {
      release();
    }
  };
  // The panel's own send is shown by its own status; another op's send (or a cancelled one still being checked) greys it.
  const lockedByOther = !tx.locked && (shared.busy || shared.cancelPending);
  return {
    tx, send, connected: Boolean(wallet), prepared: tx.status === "wallet" ? prepared : null,
    locked: tx.locked || shared.busy || shared.cancelPending, lockedByOther, cancelPending: shared.cancelPending,
  };
}

export type PositionTx = Pick<ReturnType<typeof usePositionTx>["tx"], "status" | "signature" | "error" | "retryable" | "retry" | "secondsLeft">
  & Partial<Pick<ReturnType<typeof usePositionTx>["tx"], "interrupted" | "dismissInterrupted">>;
type PositionLock = Pick<ReturnType<typeof usePositionTx>, "lockedByOther" | "cancelPending">;

/** Why a panel is greyed while another send on the same position runs (or a cancelled one is still being checked). */
function LockNote({ lock }: { lock: PositionLock }) {
  if (!lock.lockedByOther) return null;
  return <p role="status" data-testid="registry-position-locked" className="mt-3 text-sm text-cream/80">
    {lock.cancelPending ? CANCEL_CHECK_PENDING_COPY : "Another transaction on this position is still in progress. This unlocks when it finishes."}
  </p>;
}

export function TxStatus({ tx, successText, walletNote }: { tx: PositionTx; successText: string; walletNote?: string | null }) {
  const stage = tx.status === "preparing" ? "Preparing the transaction…"
    : tx.status === "wallet" ? "Confirm in your wallet…"
    : tx.status === "checking" ? CHECKING_SOLANA_COPY
    // A voided prompt's transaction could still land: no Try again until it has expired (or it landed: step done).
    : tx.status === "expiring" ? `${TX_WAITING_PREVIOUS_EXPIRY_COPY}${tx.secondsLeft ? ` About ${tx.secondsLeft} s left.` : ""}`
    : tx.status === "confirming" ? "Confirming on Solana…" : null;
  if (stage) return <>
    <p role="status" className="mt-3 flex items-center gap-2 text-sm text-cream/80"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{stage}</p>
    {tx.status === "wallet" && walletNote ? <p data-testid="registry-wallet-note" className="mt-2 rounded-inset border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{walletNote}</p> : null}
  </>;
  if (tx.status === "success") return <p role="status" className="mt-3 text-sm text-cream/80">
    {successText}{tx.signature ? <> · <a href={solscanTxUrl(tx.signature)} target="_blank" rel="noreferrer" className="underline">View on Solscan</a></> : null}
  </p>;
  if (tx.status === "failed") return <div role="alert" className="mt-3 flex gap-2 rounded-inset border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <div><p>{tx.error}</p>
      {tx.signature ? <a href={solscanTxUrl(tx.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-block underline">View on Solscan</a> : null}
      {tx.retryable ? <button type="button" onClick={tx.retry} className="mt-2 block text-xs font-semibold underline">Try again</button> : null}
    </div>
  </div>;
  if (tx.interrupted) return <InterruptedNote entry={tx.interrupted} onDismiss={tx.dismissInterrupted} />;
  return null;
}

/** PR10 marker: an earlier multi-step run of this panel stopped half-way (the panel went away between steps). */
function InterruptedNote({ entry, onDismiss }: { entry: TxInterruption; onDismiss?: () => void }) {
  return <div role="status" data-testid="tx-interrupted" className="mt-3 flex gap-2 rounded-inset border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <div><p>{txInterruptionMessage(entry)}</p>
      {entry.signatures.map((signature, index) => <a key={signature} href={solscanTxUrl(signature)} target="_blank" rel="noreferrer" className="mt-1 mr-3 inline-block underline">Step {index + 1} on Solscan</a>)}
      {onDismiss ? <button type="button" onClick={onDismiss} className="mt-2 block text-xs font-semibold underline">Dismiss</button> : null}
    </div>
  </div>;
}

function NotConnected() {
  return <p className="mt-4 text-sm text-smoke">Connect your wallet to use this position.</p>;
}

const ADD_CHECK_DEBOUNCE_MS = 400;

/**
 * Quote-time check of an Add (POST /api/dex/[dex]/quote-add), debounced like the open quote. `pending` while the
 * current amount is being checked. A failed check does not block: the build's simulation still refuses an add that
 * adds no liquidity.
 */
function useAddCheck(dexId: string, positionKey: string, owner: string | null, input: { token: string; amountRaw: string } | null, paused: boolean) {
  const key = owner && input ? JSON.stringify({ owner, positionKey, input }) : "";
  const [check, setCheck] = useState<{ key: string; value?: AddQuote; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!key || paused) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      setCheck({ key });
      fetchAddQuote(dexId, JSON.parse(key) as Parameters<typeof fetchAddQuote>[1], aborter.signal)
        .then((value) => setCheck({ key, value }))
        .catch(() => { if (!aborter.signal.aborted) setCheck({ key, failed: true }); });
    }, ADD_CHECK_DEBOUNCE_MS);
    return () => { aborter.abort(); window.clearTimeout(timer); };
  }, [key, dexId, paused]);
  const current = check?.key === key ? check : null;
  return { pending: Boolean(key) && !paused && (!current || (!current.value && !current.failed)), quote: current?.value ?? null, failed: Boolean(current?.failed) };
}

function RegistryAddPanel({ position, descriptor, balances, symbolOf, onConfirmed }: RegistryToolProps) {
  const { address: owner } = useWalletConnection();
  const op = usePositionTx("add", position, onConfirmed);
  const { tx, send, connected, locked } = op;
  const tokens = useMemo(() => {
    const list: TokenRef[] = [];
    const { poolTokens, extra } = descriptor.meta.depositInputs;
    if (poolTokens) list.push(position.tokenA, position.tokenB);
    for (const token of extra) if (!list.some((item) => item.id === token.id)) list.push(token);
    return list;
  }, [descriptor, position]);
  const [tokenId, setTokenId] = useState(tokens[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const token = tokens.find((item) => item.id === tokenId) ?? tokens[0];
  const balance = token ? balances[token.id] : undefined;
  let raw: bigint | null = null;
  let problem = "";
  if (token && amount.trim()) {
    try { raw = parseTokenAmount(amount.trim(), token.decimals); } catch { problem = `Enter an amount with at most ${token.decimals} decimals.`; }
    if (raw !== null && raw <= 0n) { problem = "Enter an amount above zero."; raw = null; }
    if (raw !== null && balance && raw > BigInt(balance.balance)) {
      problem = `Not enough ${symbolOf(token)}: your wallet has ${formatAmount(balance.balance, token.decimals)}.`;
      raw = null;
    }
  }
  const pair = `${symbolOf(position.tokenA)} and ${symbolOf(position.tokenB)}`;
  const input = token && raw !== null ? { token: token.id, amountRaw: raw.toString() } : null;
  const check = useAddCheck(descriptor.id, position.key, connected ? owner || null : null, input, locked);
  // A failed check is never skipped: Add stays disabled with a plain "try again" (Open already needs its quote).
  const tooSmall = !token ? null : check.failed ? DEPOSIT_MINIMUM_UNAVAILABLE
    : depositTooSmallMessage(check.quote?.depositMinimum, { id: token.id, decimals: token.decimals, symbol: symbolOf(token) });
  const submit = () => {
    if (!token || raw === null || tooSmall || check.pending) return;
    void send({ descriptor, positionKey: position.key, input: { token: token.id, amountRaw: raw.toString() } });
  };
  return <section className={CARD} data-testid="registry-add" aria-labelledby="registry-add-heading">
    <h2 id="registry-add-heading" className="text-lg font-semibold text-cream">Add to existing position</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Adds liquidity to this position at its current price range. We swap part of your input into {pair} as needed. {feeLine(descriptor.meta.feePolicy.add, "into the pool tokens")}</p>
    {!connected ? <NotConnected /> : <>
      <label htmlFor="registry-add-token" className={LABEL}>Token to add</label>
      <select id="registry-add-token" disabled={locked} value={token?.id ?? ""} onChange={(event) => { setTokenId(event.target.value); setAmount(""); }} className={`mt-2 ${FIELD}`}>
        {tokens.map((item) => <option key={item.id} value={item.id}>{symbolOf(item)}</option>)}
      </select>
      <div className="mt-5 flex items-center justify-between">
        <label htmlFor="registry-add-amount" className="text-xs font-medium uppercase tracking-[0.16em] text-smoke">Amount</label>
        {balance && token ? <button type="button" disabled={locked} onClick={() => setAmount(formatAmount(balance.balance, token.decimals, token.decimals).replace(/,/g, ""))} className="text-xs text-smoke underline">
          Wallet: {formatAmount(balance.balance, token.decimals)} · Max</button> : null}
      </div>
      <input id="registry-add-amount" disabled={locked} inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} className={`mt-2 ${FIELD}`} />
      {problem ? <p role="alert" className="mt-2 text-xs text-cream/80">{problem}</p> : null}
      {check.pending && !tx.locked ? <p role="status" className="mt-2 flex items-center gap-2 text-xs text-smoke"><LoaderCircle aria-hidden="true" className="size-3 animate-spin" />Checking this amount…</p> : null}
      {tooSmall ? <p role="alert" data-testid="registry-add-too-small" className="mt-2 text-xs text-cream/80">{tooSmall}</p> : null}
      <button type="button" disabled={locked || raw === null || Boolean(tooSmall) || check.pending} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}Add liquidity
      </button>
      <LockNote lock={op} />
      <TxStatus tx={tx} successText="Liquidity added." />
    </>}
  </section>;
}

const OUTPUT_LABEL: Record<WithdrawOutput, (pair: string) => string> = {
  "pool-tokens": (pair) => `Pool tokens (${pair})`,
  usdc: () => "USDC",
  sol: () => "SOL",
};

function RegistryWithdrawPanel({ position, descriptor, capabilities, symbolOf, onConfirmed }: RegistryToolProps) {
  const op = usePositionTx("withdraw", position, onConfirmed);
  const { tx, send, connected, locked } = op;
  const partial = capabilities.withdraw.supported && capabilities.withdraw.partial;
  const outputs = capabilities.withdrawOutputs;
  const [percent, setPercent] = useState(100);
  const [output, setOutput] = useState<WithdrawOutput>(outputs[0] ?? "pool-tokens");
  const pair = `${symbolOf(position.tokenA)} and ${symbolOf(position.tokenB)}`;
  const rentLine = percent === 100 ? closeRentLine(position, descriptor) : null;
  const feesLine = percent < 100 ? partialWithdrawFeesLine(capabilities) : null;
  const submit = () => void send({ descriptor, positionKey: position.key, fraction: percent / 100, output });
  return <section className={CARD} data-testid="registry-withdraw" aria-labelledby="registry-withdraw-heading">
    <h2 id="registry-withdraw-heading" className="text-lg font-semibold text-cream">Withdraw</h2>
    {!connected ? <NotConnected /> : <>
      {partial ? <>
        <label htmlFor="registry-withdraw-percent" className={LABEL}>Amount to withdraw: {percent}%</label>
        <input id="registry-withdraw-percent" type="range" min={1} max={100} step={1} disabled={locked} value={percent}
          onChange={(event) => setPercent(Number(event.target.value))} className="mt-3 w-full accent-[#fff27f]" />
        <div className="mt-2 flex gap-2">{[25, 50, 75, 100].map((value) => <button key={value} type="button" disabled={locked} onClick={() => setPercent(value)}
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${percent === value ? "border-white/60 text-cream" : "border-white/20 text-smoke"}`}>{value}%</button>)}</div>
      </> : <p className="mt-4 text-sm text-cream/80">This position can only be withdrawn in full.</p>}
      {outputs.length > 1 ? <>
        <label htmlFor="registry-withdraw-output" className={LABEL}>Receive</label>
        <select id="registry-withdraw-output" disabled={locked} value={output} onChange={(event) => setOutput(event.target.value as WithdrawOutput)} className={`mt-2 ${FIELD}`}>
          {outputs.map((item) => <option key={item} value={item}>{OUTPUT_LABEL[item](pair)}</option>)}
        </select>
      </> : <p className="mt-4 text-sm text-cream/80">You receive {output === "pool-tokens" ? pair : OUTPUT_LABEL[output](pair)} in your wallet.</p>}
      {output !== "pool-tokens" ? <p className="mt-2 text-xs leading-5 text-smoke">{feeLine(descriptor.meta.feePolicy.withdrawUsdc, "")}</p> : null}
      {feesLine ? <p data-testid="registry-withdraw-fees" className="mt-4 text-sm text-cream/80">{feesLine}</p> : null}
      {rentLine ? <p data-testid="registry-withdraw-rent" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{rentLine}</p> : null}
      <button type="button" disabled={locked} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{percent === 100 ? "Withdraw all and close" : `Withdraw ${percent}%`}
      </button>
      <LockNote lock={op} />
      <TxStatus tx={tx} successText="Withdrawal confirmed." />
    </>}
  </section>;
}

function RegistryClaimPanel({ position, descriptor, symbolOf, onConfirmed }: RegistryToolProps) {
  const op = usePositionTx("claim", position, onConfirmed);
  const { tx, send, connected, locked } = op;
  const fees = position.holdings?.unclaimedFeesRaw ?? null;
  const nothing = fees !== null && BigInt(fees.a) === 0n && BigInt(fees.b) === 0n;
  const submit = () => void send({ descriptor, positionKey: position.key });
  return <section className={CARD} data-testid="registry-claim" aria-labelledby="registry-claim-heading">
    <h2 id="registry-claim-heading" className="text-lg font-semibold text-cream">Claim fees</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Sends the unclaimed swap fees to your wallet; your liquidity stays in the position. {feeLine(descriptor.meta.feePolicy.claim, "")}</p>
    {fees ? <p className="mt-3 text-sm text-cream/80">Unclaimed: {formatAmount(fees.a, position.tokenA.decimals)} {symbolOf(position.tokenA)} · {formatAmount(fees.b, position.tokenB.decimals)} {symbolOf(position.tokenB)}</p> : null}
    {!connected ? <NotConnected /> : <>
      <button type="button" disabled={locked || nothing} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{nothing ? "No fees to claim yet" : "Claim fees"}
      </button>
      <LockNote lock={op} />
      <TxStatus tx={tx} successText="Fees claimed." />
    </>}
  </section>;
}

/**
 * Which raw fee amounts a compound can put back: in range both sides; out of range only the token the range holds at
 * the current price (price below the range → all token A, above → all token B: how every concentrated-liquidity
 * range works, so no DEX branch). Null when the fees were not read.
 */
function compoundableFees(position: UnifiedPosition): { a: bigint; b: bigint; leftA: bigint; leftB: bigint } | null {
  const fees = position.holdings?.unclaimedFeesRaw ?? null;
  if (!fees || !/^\d+$/.test(fees.a) || !/^\d+$/.test(fees.b)) return null;
  const a = BigInt(fees.a);
  const b = BigInt(fees.b);
  if (position.rangeStatus === "below") return { a, b: 0n, leftA: 0n, leftB: b };
  if (position.rangeStatus === "above") return { a: 0n, b, leftA: a, leftB: 0n };
  return { a, b, leftA: 0n, leftB: 0n };
}

/** Out of range, only one side of the fees can go back in: name both tokens (PM review of #289). */
export function compoundRangeLine(position: UnifiedPosition, symbolOf: (token: TokenRef) => string): string | null {
  if (position.rangeStatus !== "below" && position.rangeStatus !== "above") return null;
  const [kept, sent] = position.rangeStatus === "below" ? [position.tokenA, position.tokenB] : [position.tokenB, position.tokenA];
  return `The price is outside this position's range. Only ${symbolOf(kept)} fees go back into the position; ${symbolOf(sent)} fees go to your wallet.`;
}

/** Why Compound is greyed before anything is sent: nothing it could put back (null when it can run). */
export function compoundBlockedReason(position: UnifiedPosition, symbolOf: (token: TokenRef) => string): string | null {
  const fees = compoundableFees(position);
  if (!fees || fees.a > 0n || fees.b > 0n) return null;
  if (fees.leftA === 0n && fees.leftB === 0n) return "This position has no unclaimed fees yet, so there is nothing to compound.";
  const [kept, other] = position.rangeStatus === "below" ? [position.tokenA, position.tokenB] : [position.tokenB, position.tokenA];
  return `There are no ${symbolOf(kept)} fees to put back while the price is outside the range. Claim the ${symbolOf(other)} fees to your wallet instead.`;
}

function RegistryCompoundPanel({ position, descriptor, symbolOf, onConfirmed }: RegistryToolProps) {
  const op = usePositionTx("compound", position, onConfirmed);
  const { tx, send, connected, locked } = op;
  const blocked = compoundBlockedReason(position, symbolOf);
  const rangeLine = compoundRangeLine(position, symbolOf);
  const poolFeeLine = position.rangeStatus === "in" ? descriptor.meta.inRangeDepositPoolFee ?? null : null;
  const tokenFor = (mint: string) => [position.tokenA, position.tokenB].find((token) => token.id === mint);
  const rentLine = tokenAccountRentLine(op.prepared?.createsTokenAccounts, (mint) => { const token = tokenFor(mint); return token ? symbolOf(token) : "pool token"; });
  const submit = () => void send({ descriptor, positionKey: position.key });
  // The pipeline's "success" is the confirmed landing (never the click); the halo plays once per signature.
  const compoundButtonRef = useRef<HTMLButtonElement>(null);
  const haloPlay = useCompoundSuccessHalo(tx.status === "success" && tx.signature ? { phase: "success", signature: tx.signature } : null);
  return <section className={CARD} data-testid="registry-compound" aria-labelledby="registry-compound-heading">
    {/* Same look and words as the Raydium Compound fees panel (LJ 11/14); the transaction flow below is unchanged. */}
    <h2 id="registry-compound-heading" className="flex items-center gap-2 text-lg font-semibold text-cream"><Sprout aria-hidden="true" className="h-5 w-5 text-cream/80" />Compound fees</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Adds this position&apos;s fees back into the same range.</p>
    <p className="mt-1 text-xs leading-5 text-smoke">{feeLine(descriptor.meta.feePolicy.compound, "")}</p>
    {/* No per-token fees line here (LJ 11/14): the position's row shows its fees. The checks (compoundBlockedReason) are unchanged. */}
    {rangeLine ? <p data-testid="registry-compound-range" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{rangeLine}</p> : null}
    {poolFeeLine ? <p data-testid="registry-compound-pool-fee" className="mt-3 text-xs leading-5 text-smoke">{poolFeeLine}</p> : null}
    {!connected ? <NotConnected /> : <>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button ref={compoundButtonRef} type="button" disabled={locked || blocked !== null} onClick={submit} className={COMPOUND_BUTTON}>
          {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Sprout aria-hidden="true" className="size-4" />}One-click compound
        </button>
        {blocked ? <span data-testid="registry-compound-blocked" role="status" className="text-xs text-smoke">{blocked}</span> : null}
      </div>
      <CompoundSuccessHalo play={haloPlay} originRef={compoundButtonRef} />
      <LockNote lock={op} />
      <TxStatus tx={tx} successText="Fees compounded." walletNote={rentLine} />
    </>}
  </section>;
}
