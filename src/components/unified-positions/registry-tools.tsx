"use client";

/**
 * Tool panels (Add / Withdraw / Claim fees, PR7; Compound, PR8) for "My positions" rows served through the DEX registry.
 * Everything here is decided from the registry: the descriptor's capabilities and meta (withdraw outputs, partial
 * withdraw, claim, compound, deposit inputs, fee policy, rent model). No layer here knows which DEX a position belongs to.
 *
 * Every send goes through the shared tx pipeline (`useTxPipeline` + `dexTxAdapter`): wallet signAndSend, loading →
 * success / failure with a Solscan link, balances refresh; the pipeline's success notice stays until dismissed.
 */
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { dexTxAdapter, type DexCapabilities, type DexDescriptor, type DexStepInput, type DexStepOp, type FeeRule } from "@/lib/dex/client";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { CHECKING_SOLANA_COPY, solscanTxUrl } from "@/lib/tx-pipeline";
import type { ToolId, TokenRef, UnifiedPosition, WithdrawOutput } from "@/lib/unified-positions/model";
import { useTxPipeline } from "../transactions/use-tx-pipeline";
import { useWalletConnection } from "../wallet-connection";

/** A wallet balance the Add panel can check against (raw atomic string). */
export type ToolBalance = { balance: string; decimals: number };

export type RegistryToolProps = {
  position: UnifiedPosition;
  descriptor: DexDescriptor;
  capabilities: DexCapabilities;
  view: ToolId;
  /** Wallet balances by token id; a missing entry means "not read" (the server still checks). */
  balances: Readonly<Record<string, ToolBalance | undefined>>;
  symbolOf: (token: TokenRef) => string;
  /** A send of this position landed: re-read positions and balances. */
  onConfirmed: () => void;
};

const CARD = "mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-8";
const BUTTON = "mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40";
const FIELD = "w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-cream outline-none focus:border-white/40 disabled:opacity-60";
const LABEL = "mt-5 block text-xs font-medium uppercase tracking-[0.16em] text-smoke";
const LAMPORTS_PER_SOL = 1_000_000_000;

export function RegistryPositionTool(props: RegistryToolProps) {
  if (props.view === "deposit" && props.capabilities.deposit.supported) return <RegistryAddPanel {...props} />;
  if (props.view === "compound" && props.capabilities.compound.supported) return <RegistryCompoundPanel {...props} />;
  if (props.view === "withdraw" && props.capabilities.withdraw.supported) return <>
    <RegistryWithdrawPanel {...props} />
    {props.capabilities.claim.supported ? <RegistryClaimPanel {...props} /> : null}
  </>;
  return null;
}

/** "0.1% fee on the part we swap" etc., from the descriptor's fee rule (no DEX knowledge). */
export function feeLine(rule: FeeRule, swapNoun: string): string {
  if (rule.kind === "none") return "No platform fee.";
  const percent = `${rule.bps / 100}%`;
  if (rule.kind === "swap-input-bps") return `A ${percent} platform fee applies only to the part we swap ${swapNoun}; nothing is charged on the rest.`;
  if (rule.kind === "swap-output-bps") return `A ${percent} platform fee applies only to the swapped output.`;
  return `A ${percent} platform fee applies to the harvested fees.`;
}

/** The rent line shown before a full withdraw is signed. */
export function closeRentLine(position: UnifiedPosition, descriptor: DexDescriptor): string | null {
  const rent = descriptor.meta.rent;
  if (!rent?.refundableOnClose) return null;
  if (position.closeRefundLamports && /^\d+$/.test(position.closeRefundLamports)) {
    const sol = Number(position.closeRefundLamports) / LAMPORTS_PER_SOL;
    return `Withdrawing 100% closes the position. Its rent, about ${sol.toFixed(4)} SOL, comes back to your wallet.`;
  }
  return "Withdrawing 100% closes the position. Its rent comes back to your wallet.";
}

/** One shared send per panel: the pipeline for `op`, scoped to this position, with multi-step plans run in order. */
function usePositionTx<Op extends DexStepOp>(op: Op, position: UnifiedPosition, onConfirmed: () => void) {
  const { address: wallet, signTransaction, signAndSendTransaction } = useWalletConnection();
  const txWallet = useMemo(() => wallet ? { address: wallet, signTransaction, signAndSendTransaction } : null,
    [wallet, signTransaction, signAndSendTransaction]);
  const adapter = useMemo(() => dexTxAdapter(op), [op]);
  const tx = useTxPipeline(adapter, txWallet, { scope: position.key });
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
  const send = async (fields: Omit<DexStepInput<Op>, "context" | "relayStore">) => {
    const priorSignatures: string[] = [];
    let planToken: string | undefined;
    for (let step = 1; step <= 8; step++) {
      const input = { ...fields, relayStore: relayStore.current,
        context: { step, priorSignatures: [...priorSignatures], ...(planToken ? { planToken } : {}) } } as unknown as DexStepInput<Op>;
      const result = await tx.run(input);
      if (!result) return;
      priorSignatures.push(result.signature);
      if (result.prepared.result.done) return;
      planToken = result.prepared.result.planToken;
    }
  };
  return { tx, send, connected: Boolean(wallet) };
}

type PositionTx = Pick<ReturnType<typeof usePositionTx>["tx"], "status" | "signature" | "error" | "retryable" | "retry">;

function TxStatus({ tx, successText }: { tx: PositionTx; successText: string }) {
  const stage = tx.status === "preparing" ? "Preparing the transaction…"
    : tx.status === "wallet" ? "Confirm in your wallet…"
    : tx.status === "checking" ? CHECKING_SOLANA_COPY
    : tx.status === "confirming" ? "Confirming on Solana…" : null;
  if (stage) return <p role="status" className="mt-3 flex items-center gap-2 text-sm text-cream/80"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{stage}</p>;
  if (tx.status === "success") return <p role="status" className="mt-3 text-sm text-cream/80">
    {successText}{tx.signature ? <> · <a href={solscanTxUrl(tx.signature)} target="_blank" rel="noreferrer" className="underline">View on Solscan</a></> : null}
  </p>;
  if (tx.status === "failed") return <div role="alert" className="mt-3 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <div><p>{tx.error}</p>
      {tx.signature ? <a href={solscanTxUrl(tx.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-block underline">View on Solscan</a> : null}
      {tx.retryable ? <button type="button" onClick={tx.retry} className="mt-2 block text-xs font-semibold underline">Try again</button> : null}
    </div>
  </div>;
  return null;
}

function NotConnected() {
  return <p className="mt-4 text-sm text-smoke">Connect your wallet to use this position.</p>;
}

function RegistryAddPanel({ position, descriptor, balances, symbolOf, onConfirmed }: RegistryToolProps) {
  const { tx, send, connected } = usePositionTx("add", position, onConfirmed);
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
  const submit = () => {
    if (!token || raw === null) return;
    void send({ descriptor, positionKey: position.key, input: { token: token.id, amountRaw: raw.toString() } });
  };
  return <section className={CARD} data-testid="registry-add" aria-labelledby="registry-add-heading">
    <h2 id="registry-add-heading" className="text-lg font-semibold text-cream">Add to existing position</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Adds liquidity to this position at its current price range. We swap part of your input into {pair} as needed. {feeLine(descriptor.meta.feePolicy.add, "into the pool tokens")}</p>
    {!connected ? <NotConnected /> : <>
      <label htmlFor="registry-add-token" className={LABEL}>Token to add</label>
      <select id="registry-add-token" disabled={tx.locked} value={token?.id ?? ""} onChange={(event) => { setTokenId(event.target.value); setAmount(""); }} className={`mt-2 ${FIELD}`}>
        {tokens.map((item) => <option key={item.id} value={item.id}>{symbolOf(item)}</option>)}
      </select>
      <div className="mt-5 flex items-center justify-between">
        <label htmlFor="registry-add-amount" className="text-xs font-medium uppercase tracking-[0.16em] text-smoke">Amount</label>
        {balance && token ? <button type="button" disabled={tx.locked} onClick={() => setAmount(formatAmount(balance.balance, token.decimals, token.decimals).replace(/,/g, ""))} className="text-xs text-smoke underline">
          Wallet: {formatAmount(balance.balance, token.decimals)} · Max</button> : null}
      </div>
      <input id="registry-add-amount" disabled={tx.locked} inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} className={`mt-2 ${FIELD}`} />
      {problem ? <p role="alert" className="mt-2 text-xs text-cream/80">{problem}</p> : null}
      <button type="button" disabled={tx.locked || raw === null} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}Add liquidity
      </button>
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
  const { tx, send, connected } = usePositionTx("withdraw", position, onConfirmed);
  const partial = capabilities.withdraw.supported && capabilities.withdraw.partial;
  const outputs = capabilities.withdrawOutputs;
  const [percent, setPercent] = useState(100);
  const [output, setOutput] = useState<WithdrawOutput>(outputs[0] ?? "pool-tokens");
  const pair = `${symbolOf(position.tokenA)} and ${symbolOf(position.tokenB)}`;
  const rentLine = percent === 100 ? closeRentLine(position, descriptor) : null;
  const submit = () => void send({ descriptor, positionKey: position.key, fraction: percent / 100, output });
  return <section className={CARD} data-testid="registry-withdraw" aria-labelledby="registry-withdraw-heading">
    <h2 id="registry-withdraw-heading" className="text-lg font-semibold text-cream">Withdraw</h2>
    {!connected ? <NotConnected /> : <>
      {partial ? <>
        <label htmlFor="registry-withdraw-percent" className={LABEL}>Amount to withdraw: {percent}%</label>
        <input id="registry-withdraw-percent" type="range" min={1} max={100} step={1} disabled={tx.locked} value={percent}
          onChange={(event) => setPercent(Number(event.target.value))} className="mt-3 w-full accent-[#fff27f]" />
        <div className="mt-2 flex gap-2">{[25, 50, 75, 100].map((value) => <button key={value} type="button" disabled={tx.locked} onClick={() => setPercent(value)}
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${percent === value ? "border-white/60 text-cream" : "border-white/20 text-smoke"}`}>{value}%</button>)}</div>
      </> : <p className="mt-4 text-sm text-cream/80">This position can only be withdrawn in full.</p>}
      {outputs.length > 1 ? <>
        <label htmlFor="registry-withdraw-output" className={LABEL}>Receive</label>
        <select id="registry-withdraw-output" disabled={tx.locked} value={output} onChange={(event) => setOutput(event.target.value as WithdrawOutput)} className={`mt-2 ${FIELD}`}>
          {outputs.map((item) => <option key={item} value={item}>{OUTPUT_LABEL[item](pair)}</option>)}
        </select>
      </> : <p className="mt-4 text-sm text-cream/80">You receive {output === "pool-tokens" ? pair : OUTPUT_LABEL[output](pair)} in your wallet.</p>}
      {output !== "pool-tokens" ? <p className="mt-2 text-xs leading-5 text-smoke">{feeLine(descriptor.meta.feePolicy.withdrawUsdc, "")}</p> : null}
      {rentLine ? <p data-testid="registry-withdraw-rent" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{rentLine}</p> : null}
      <button type="button" disabled={tx.locked} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{percent === 100 ? "Withdraw all and close" : `Withdraw ${percent}%`}
      </button>
      <TxStatus tx={tx} successText="Withdrawal confirmed." />
    </>}
  </section>;
}

function RegistryClaimPanel({ position, descriptor, symbolOf, onConfirmed }: RegistryToolProps) {
  const { tx, send, connected } = usePositionTx("claim", position, onConfirmed);
  const fees = position.holdings?.unclaimedFeesRaw ?? null;
  const nothing = fees !== null && BigInt(fees.a) === 0n && BigInt(fees.b) === 0n;
  const submit = () => void send({ descriptor, positionKey: position.key });
  return <section className={CARD} data-testid="registry-claim" aria-labelledby="registry-claim-heading">
    <h2 id="registry-claim-heading" className="text-lg font-semibold text-cream">Claim fees</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Sends the unclaimed swap fees to your wallet; your liquidity stays in the position. {feeLine(descriptor.meta.feePolicy.claim, "")}</p>
    {fees ? <p className="mt-3 text-sm text-cream/80">Unclaimed: {formatAmount(fees.a, position.tokenA.decimals)} {symbolOf(position.tokenA)} · {formatAmount(fees.b, position.tokenB.decimals)} {symbolOf(position.tokenB)}</p> : null}
    {!connected ? <NotConnected /> : <>
      <button type="button" disabled={tx.locked || nothing} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{nothing ? "No fees to claim yet" : "Claim fees"}
      </button>
      <TxStatus tx={tx} successText="Fees claimed." />
    </>}
  </section>;
}

/** Out of range, only one side of the fees can go back in (the server measures and says so in the step label too). */
export function compoundRangeLine(position: UnifiedPosition): string | null {
  if (position.rangeStatus !== "below" && position.rangeStatus !== "above") return null;
  return "The price is outside this position's range, so only the fees in the token the range holds right now go back in. The rest goes to your wallet.";
}

function RegistryCompoundPanel({ position, descriptor, symbolOf, onConfirmed }: RegistryToolProps) {
  const { tx, send, connected } = usePositionTx("compound", position, onConfirmed);
  const fees = position.holdings?.unclaimedFeesRaw ?? null;
  const nothing = fees !== null && BigInt(fees.a) === 0n && BigInt(fees.b) === 0n;
  const rangeLine = compoundRangeLine(position);
  const submit = () => void send({ descriptor, positionKey: position.key });
  return <section className={CARD} data-testid="registry-compound" aria-labelledby="registry-compound-heading">
    <h2 id="registry-compound-heading" className="text-lg font-semibold text-cream">Compound fees</h2>
    <p className="mt-2 text-xs leading-5 text-smoke">Claims the unclaimed swap fees and adds them back into this position at its current price range, in one transaction. No swap is needed. {feeLine(descriptor.meta.feePolicy.compound, "")}</p>
    {fees ? <p className="mt-3 text-sm text-cream/80">Unclaimed: {formatAmount(fees.a, position.tokenA.decimals)} {symbolOf(position.tokenA)} · {formatAmount(fees.b, position.tokenB.decimals)} {symbolOf(position.tokenB)}</p> : null}
    {rangeLine ? <p data-testid="registry-compound-range" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{rangeLine}</p> : null}
    {!connected ? <NotConnected /> : <>
      <button type="button" disabled={tx.locked || nothing} onClick={submit} className={BUTTON}>
        {tx.locked ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{nothing ? "No fees to compound yet" : "Compound fees"}
      </button>
      <TxStatus tx={tx} successText="Fees compounded." />
    </>}
  </section>;
}
