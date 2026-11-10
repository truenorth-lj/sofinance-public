"use client";

/**
 * Open a new position on a DEX served through the registry (PR10; DESIGN.md §8.y), from the unified pools panel.
 * Everything comes from the descriptor: deposit inputs, the per-position range cap (`meta.maxRangeUnitsPerPosition`),
 * the rent model, the open fee rule and the number of steps. No layer here knows which DEX the pool belongs to.
 *
 * Flow: pick a token (the pool's two or the descriptor's extra inputs; never native SOL) → amount → a preset range
 * (wider than the cap: shown as "not available to open yet") → POST /api/dex/[dex]/quote-open (rent, fee, blocked
 * reason) → each step through `dexTxAdapter("open")` + `useTxPipeline().runSteps`: loading → success / failure with a
 * Solscan link → balances refresh (the pipeline's notice asks every panel to re-read).
 */
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { OPEN_RANGE_UI_PRESETS } from "@sofinance/engine/open-range-presets";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { depositTooSmallMessage, dexTxAdapter, OPEN_RANGES_UNAVAILABLE, openSolNeed, openSolPartsFromQuote, type DexDescriptor, type DexPreparedStep, type DexStepInput, type OpenQuote, type OpenRangePreset, type OpenRanges } from "@/lib/dex/client";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { BALANCES_REFRESH_EVENT } from "@/lib/tx-pipeline";
import { formatAprPct } from "@/lib/range-apr/format";
import type { RangeAprPresetId, PoolRangeAprPayload } from "@/lib/range-apr/types";
import type { UnifiedPool } from "@/lib/unified-pools/model";
import type { TokenRef } from "@/lib/unified-positions/model";
import type { PoolRangeAprState } from "../range-apr/use-pool-range-apr";
import { OpenPositionForm } from "../open-position/open-position-form";
import { useTxPipeline } from "../transactions/use-tx-pipeline";
import { feeLine, openRentLines, TxStatus, tokenAccountRentLine } from "../unified-positions/registry-tools";
import { useWalletConnection } from "../wallet-connection";

/** Slippage for the swap legs of an open (code constant; PR10 rule: no new env flags). */
export const OPEN_SLIPPAGE_BPS = 50;
/** Wait after the last keystroke before asking for a quote. */
const QUOTE_DEBOUNCE_MS = 400;
export const NETWORK_FEE_COPY = "Network fee is set by your wallet.";
export const SOL_RESERVE_COPY = "Keep some SOL beyond the rent. Your wallet may add a priority fee to each step (often about 0.001–0.002 SOL), and that fee must also fit in your SOL.";
export const SOL_REFUSED_COPY = "SOL can't be used to open a position. Use one of the listed tokens.";
export const RANGE_TOO_WIDE_COPY = (units: number, max: number, unit: string) =>
  `Not available to open yet: this range spans ${units} ${unit}s, and one position holds at most ${max}.`;

/** Exact text of a preset's APR when the volume / APR feed has no estimate for it (never 0% or a guess). */
export const APR_UNAVAILABLE = "APR unavailable";

export type PresetOption = { id: RangeAprPresetId; units: number; priceLower: number; priceUpper: number; available: boolean; reason: string | null; apr: string };

/**
 * APR of one server-worked-out preset from the range APR payload. Prefer the same preset id over the same bounds
 * (payload ticks are unit × tick spacing; the upper bound is exclusive). When the live open-ranges bounds have drifted
 * from the snapshot (the price moved), fall back to the same preset id: "Micro" is the same width around the current
 * price. A degraded or missing feed, or a preset with no usable estimate, stays APR_UNAVAILABLE (never 0% or a guess).
 */
const formatOkApr = (estimate: { status: string; aprPct?: number } | undefined): string | null =>
  estimate?.status === "ok" && typeof estimate.aprPct === "number" && Number.isFinite(estimate.aprPct)
    ? `Est. APR ${formatAprPct(estimate.aprPct)}` : null;

export function presetApr(preset: OpenRangePreset, apr: PoolRangeAprPayload | Error | null): string {
  if (!apr || apr instanceof Error || apr.sample?.degraded) return APR_UNAVAILABLE;
  const spacing = Math.max(1, apr.pool.tickSpacing);
  const sameBounds = apr.presets?.find((item) => item.id === preset.id && item.tickLower / spacing === preset.lowerUnit && item.tickUpper / spacing - 1 === preset.upperUnit);
  return formatOkApr(sameBounds?.estimate) ?? formatOkApr(apr.presets?.find((item) => item.id === preset.id)?.estimate) ?? APR_UNAVAILABLE;
}

/** The server's preset ranges with their width, whether one position can hold them, and their APR (or APR_UNAVAILABLE). */
export function presetOptions(presets: readonly OpenRangePreset[], descriptor: Pick<DexDescriptor, "meta">, apr: PoolRangeAprPayload | Error | null = null): PresetOption[] {
  const max = descriptor.meta.maxRangeUnitsPerPosition;
  return presets.map((preset) => {
    const available = max === null || preset.units <= max;
    return { id: preset.id, units: preset.units, priceLower: preset.priceLower, priceUpper: preset.priceUpper, available,
      reason: available ? null : RANGE_TOO_WIDE_COPY(preset.units, max!, descriptor.meta.rangeUnit), apr: presetApr(preset, apr) };
  });
}

/** Tokens the open accepts: the pool's two plus the descriptor's extra inputs, never native SOL. */
export function openInputs(pool: Pick<UnifiedPool, "mintA" | "mintB" | "symbolA" | "symbolB">, descriptor: Pick<DexDescriptor, "meta">,
  decimals: { a: number; b: number } | null): TokenRef[] {
  const list: TokenRef[] = [];
  const { poolTokens, extra } = descriptor.meta.depositInputs;
  if (poolTokens && decimals) list.push({ id: pool.mintA, symbol: pool.symbolA, decimals: decimals.a }, { id: pool.mintB, symbol: pool.symbolB, decimals: decimals.b });
  for (const token of extra) if (!list.some((item) => item.id === token.id)) list.push(token);
  return list.filter((token) => token.id !== NATIVE_SOL_MINT);
}

type Balances = { sol: bigint | null; byMint: Record<string, string> };
type WalletAssets = { assets?: { mint: string; kind: string; balance: string }[] };
const solText = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);
/** The SOL-short message: what the open needs (rent, network fees, temporary swap accounts, reserve), what the wallet has, and what is missing. */
export const solShortCopy = (need: bigint, have: bigint) =>
  `Not enough SOL: this open needs about ${solText(need)} SOL (rent, network fees, temporary swap accounts and a small reserve), and your wallet has ${solText(have)} SOL. Add about ${solText(need - have)} SOL to open.`;
const price = (value: number) => (value >= 1 ? value.toPrecision(6) : value.toPrecision(4));

function useWalletBalances(wallet: string | null): Balances | null {
  const [balances, setBalances] = useState<{ wallet: string; value: Balances } | null>(null);
  useEffect(() => {
    if (!wallet) return;
    let live = true;
    const read = () => void fetch(`/api/wallet?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? await response.json() as WalletAssets : null))
      .then((found) => {
        if (!live || !found?.assets) return;
        const byMint: Record<string, string> = {};
        let sol: bigint | null = null;
        for (const asset of found.assets) {
          if (asset.kind === "native") sol = /^\d+$/.test(asset.balance) ? BigInt(asset.balance) : null;
          else byMint[asset.mint] = asset.balance;
        }
        setBalances({ wallet, value: { sol, byMint } });
      })
      .catch(() => { /* balances stay unknown; the server still checks */ });
    read();
    window.addEventListener(BALANCES_REFRESH_EVENT, read);
    return () => { live = false; window.removeEventListener(BALANCES_REFRESH_EVENT, read); };
  }, [wallet]);
  return balances && balances.wallet === wallet ? balances.value : null;
}

export type RegistryOpenModalProps = {
  pool: UnifiedPool;
  descriptor: DexDescriptor;
  /** The server's preset ranges (POST /api/dex/[dex]/open-ranges); null while they load, an Error when they could not be worked out. */
  ranges: OpenRanges | Error | null;
  /** Optional APR estimates for those ranges; null / Error → every preset reads APR_UNAVAILABLE and opening still works. */
  apr?: PoolRangeAprPayload | Error | null;
  onClose: () => void;
};

export function RegistryOpenModal({ pool, descriptor, ranges, apr = null, onClose }: RegistryOpenModalProps) {
  const { address: wallet, connected, connect, signTransaction, signAndSendTransaction } = useWalletConnection();
  const txWallet = useMemo(() => (wallet ? { address: wallet, signTransaction, signAndSendTransaction } : null), [wallet, signTransaction, signAndSendTransaction]);
  const adapter = useMemo(() => dexTxAdapter("open"), []);
  const tx = useTxPipeline(adapter, txWallet, { scope: `open:${pool.key}`, inlineErrors: true });
  const relayStore = useRef(createJupiterRelayStore());
  const balances = useWalletBalances(wallet || null);
  const payload = ranges instanceof Error ? null : ranges;
  const tokens = useMemo(() => openInputs(pool, descriptor, payload && payload.decimals[pool.mintA] !== undefined && payload.decimals[pool.mintB] !== undefined
    ? { a: payload.decimals[pool.mintA]!, b: payload.decimals[pool.mintB]! } : null), [pool, descriptor, payload]);
  const solIsPoolToken = descriptor.meta.depositInputs.poolTokens && (pool.mintA === NATIVE_SOL_MINT || pool.mintB === NATIVE_SOL_MINT);
  const presets = useMemo(() => (payload ? presetOptions(payload.presets, descriptor, apr) : []), [payload, descriptor, apr]);
  const [tokenId, setTokenId] = useState("");
  const [presetId, setPresetId] = useState<RangeAprPresetId | "">("");
  const [amount, setAmount] = useState("");
  const token = tokens.find((item) => item.id === tokenId) ?? tokens[0];
  const preset = presets.find((item) => item.id === presetId && item.available) ?? presets.find((item) => item.available && item.id === "standard") ?? presets.find((item) => item.available);
  const unavailable = useMemo(() => {
    const next: Partial<Record<RangeAprPresetId, string>> = {};
    for (const item of presets) if (!item.available && item.reason) next[item.id] = item.reason;
    return next;
  }, [presets]);
  const aprState: PoolRangeAprState = !apr ? { status: "loading" }
    : apr instanceof Error ? { status: "error", message: apr.message }
    : { status: "ready", data: apr };
  const pickerSelected = preset?.id ?? "standard";

  let raw: bigint | null = null;
  let problem = "";
  if (token && amount.trim()) {
    try { raw = parseTokenAmount(amount.trim(), token.decimals); } catch { problem = `Enter an amount with at most ${token.decimals} decimals.`; }
    if (raw !== null && raw <= 0n) { problem = "Enter an amount above zero."; raw = null; }
    const have = balances?.byMint[token.id];
    if (raw !== null && have !== undefined && raw > BigInt(have)) { problem = `Not enough ${token.symbol}: your wallet has ${formatAmount(have, token.decimals)}.`; raw = null; }
  }

  const request = token && preset && raw !== null
    ? { poolId: pool.poolAddress, range: { kind: "preset" as const, presetId: preset.id }, input: { token: token.id, amountRaw: raw.toString() }, slippageBps: OPEN_SLIPPAGE_BPS }
    : null;
  const requestKey = request ? JSON.stringify(request) : "";
  const [quote, setQuote] = useState<{ key: string; value?: OpenQuote; error?: string } | null>(null);
  useEffect(() => {
    if (!requestKey || !wallet || tx.locked) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      setQuote({ key: requestKey });
      void fetch(`/api/dex/${encodeURIComponent(descriptor.id)}/quote-open`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: aborter.signal,
        body: JSON.stringify({ request: { ...JSON.parse(requestKey), owner: wallet } }),
      }).then(async (response) => {
        const body = await response.json().catch(() => null) as (OpenQuote & { error?: string }) | null;
        if (!response.ok || !body) throw new Error(body?.error || `The quote could not be loaded (server error ${response.status}). Try again in a moment.`);
        setQuote({ key: requestKey, value: body });
      }).catch((error: unknown) => {
        if (aborter.signal.aborted) return;
        setQuote({ key: requestKey, error: error instanceof Error ? error.message : "The quote could not be loaded. Try again in a moment." });
      });
    }, QUOTE_DEBOUNCE_MS);
    return () => { aborter.abort(); window.clearTimeout(timer); };
  }, [requestKey, wallet, descriptor.id, tx.locked]);
  const current = quote && quote.key === requestKey ? quote : null;
  const quoted = current?.value ?? null;
  const rent = openRentLines(quoted?.rent);
  // Same parts the server's INSUFFICIENT_FUNDS check adds (openSolNeed): rent + network fees + swap accounts + reserve.
  // A quote without those parts can't be priced: block Open with the reason instead of counting the rent only.
  const solParts = quoted ? openSolPartsFromQuote(rent.totalLamports, quoted.sol) : null;
  const solUnknown = solParts && !solParts.ok && !quoted?.blockedReason ? solParts.reason : null;
  const solNeed = solParts?.ok ? openSolNeed(solParts.parts) : 0n;
  const solShort = Boolean(solParts?.ok && !quoted?.blockedReason && balances?.sol !== null && balances?.sol !== undefined && balances.sol < solNeed);

  const [prepared, setPrepared] = useState<DexPreparedStep["result"] | null>(null);
  const submit = async () => {
    if (!request) return;
    const inputFor = (step: number, priorSignatures: string[], planToken?: string) => ({
      descriptor, request, relayStore: relayStore.current, beforeWallet: setPrepared,
      context: { step, priorSignatures, ...(planToken ? { planToken } : {}) },
    }) as DexStepInput<"open">;
    setPrepared(null);
    await tx.runSteps(inputFor(1, []), {
      progress: (step) => ({ step: step.result.step, of: step.result.of }),
      next: (sent, earlier) => {
        setPrepared(null);
        const { done, step, planToken } = sent.prepared.result;
        return done ? null : inputFor(step + 1, [...earlier, sent].map((item) => item.signature), planToken);
      },
    });
  };

  const blocked = quoted?.blockedReason ?? null;
  // Shared "too small for this range" rule (same as Add): the quote says the amount would round to 0 in some step.
  const tooSmall = blocked ? null : depositTooSmallMessage(quoted?.depositMinimum, token);
  const ready = Boolean(connected && request && quoted && !blocked && !tooSmall && !solUnknown && !solShort && !tx.locked && tx.status !== "success");
  const steps = quoted?.steps ?? descriptor.meta.openSteps.max;
  const walletNote = tx.status === "wallet" && prepared ? tokenAccountRentLine(prepared.createsTokenAccounts, (mint) => tokens.find((item) => item.id === mint)?.symbol ?? "token") : null;
  const stepText = tx.step?.of && tx.step.of > 1 && tx.locked ? `Step ${tx.step.step} of ${tx.step.of}` : null;

  const assets = tokens.map((item) => {
    const have = balances?.byMint[item.id];
    return {
      id: item.id,
      label: have !== undefined ? `${item.symbol} · ${formatAmount(have, item.decimals)}` : item.symbol,
    };
  });
  const rangesError = ranges instanceof Error
    ? (ranges.message === OPEN_RANGES_UNAVAILABLE ? ranges.message
      : `This pool's price ranges could not be worked out, so it can't be opened right now: ${ranges.message}`)
    : null;

  return <div data-testid="registry-open-modal">
    <OpenPositionForm
      labelledBy="registry-open-heading"
      pairLabel={pool.pairLabel}
      venueName={descriptor.displayName}
      explainer="Choose a wallet asset and price range. We swap into the pool tokens as needed, then create a new LP position."
      closeLocked={tx.closeLocked}
      onClose={onClose}
      assets={assets}
      assetId={token?.id ?? ""}
      onAssetChange={(id) => { setTokenId(id); setAmount(""); }}
      assetSelectId="registry-open-token"
      assetPlaceholder="Select a token"
      assetDisabled={tx.locked}
      assetNote={solIsPoolToken ? <p data-testid="registry-open-sol" className="mt-2 text-xs text-smoke">{SOL_REFUSED_COPY}</p> : null}
      amount={amount}
      onAmountChange={setAmount}
      amountInputId="registry-open-amount"
      amountDisabled={tx.locked}
      amountProblem={problem ? <p role="alert" className="mt-2 text-xs text-cream/80">{problem}</p> : null}
      onFillMax={() => {
        if (token && balances?.byMint[token.id]) setAmount(formatAmount(balances.byMint[token.id]!, token.decimals, token.decimals).replace(/,/g, ""));
      }}
      maxDisabled={tx.locked}
      range={{
        presets: OPEN_RANGE_UI_PRESETS,
        selected: pickerSelected,
        onSelect: (id) => { if (id !== "custom") setPresetId(id); },
        minPrice: "",
        maxPrice: "",
        onMinPrice: () => {},
        onMaxPrice: () => {},
        apr: aprState,
        quotedRange: null,
        capitalUsd: null,
        showCustom: false,
        unavailable,
      }}
      notes={<>
        {rangesError ? <p role="alert" data-testid="registry-open-ranges-error" className="mt-4 text-sm text-cream/80">{rangesError}</p> : null}
        {!rangesError && !payload ? <p role="status" className="mt-4 flex items-center gap-2 text-sm text-cream/80"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading this pool&apos;s ranges…</p> : null}
        <div className="mt-5 space-y-2 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs text-cream/80" data-testid="registry-open-costs">
          {current && !current.value && !current.error ? <p role="status" className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Getting a quote…</p> : null}
          {current?.error ? <p role="alert">{current.error}</p> : null}
          {quoted ? <p>Range: {price(quoted.range.lowerPrice)} – {price(quoted.range.upperPrice)} ({quoted.range.units} {descriptor.meta.rangeUnit}s)</p> : null}
          {rent.lines.length ? rent.lines.map((line) => <p key={line}>{line}</p>) : descriptor.meta.rent ? <p>{descriptor.meta.rent.disclosure}</p> : null}
          <p>{feeLine(descriptor.meta.feePolicy.open, "into the pool tokens")}{quoted && token && /^\d+$/.test(quoted.platformFeeRaw) && quoted.platformFeeRaw !== "0" ? ` About ${formatAmount(quoted.platformFeeRaw, token.decimals)} ${token.symbol} on this open.` : ""}</p>
          <p>{NETWORK_FEE_COPY} {SOL_RESERVE_COPY}</p>
          {steps > 1 ? <p>Your wallet asks you to approve {steps} transactions, one after the other.</p> : null}
          {solUnknown ? <p role="alert" data-testid="registry-open-sol-unknown">{solUnknown}</p> : null}
          {solShort ? <p role="alert" data-testid="registry-open-sol-short">{solShortCopy(solNeed, balances!.sol!)}</p> : null}
          {blocked ? <p role="alert" data-testid="registry-open-blocked">{blocked}</p> : null}
          {tooSmall ? <p role="alert" data-testid="registry-open-too-small">{tooSmall}</p> : null}
        </div>
        <TxStatus tx={tx} walletNote={walletNote} successText="Position opened. It shows under My positions." />
      </>}
      connected={connected}
      onConnect={connect}
      submitLabel={stepText ? `${stepText}…` : "Create position"}
      onSubmit={() => { void submit(); }}
      submitDisabled={!ready}
      submitBusy={tx.locked}
      submitBusyLabel={stepText ? `${stepText}…` : "Create position"}
      submitTestId="registry-open-submit"
    />
  </div>;
}
