"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  applyPlanChange,
  parsePlanSetup,
  type PlanSetup,
} from "@/lib/lp-plan-intent";
import { parsePairLabel, parseSolanaAddress, resolvePlanSelection } from "@/lib/lp-plan-selection";
import { effectiveExit, planPoolTerms, projectPoolPlan } from "@/lib/lp-plan-pool-terms";
import { lowPlanApr, pairLabelSymbols, planShareSymbol } from "@/lib/lp-plan-shares";
import { dexDescriptors } from "@/lib/dex/client";
import { openUnavailableReason, type UnifiedProtocol } from "@/lib/unified-pools/model";
import { APP_ROUTES } from "@/lib/public-urls";
import { InkNav } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { ComparisonChart } from "./comparison-chart";
import { IntentSentence, type IntentField } from "./intent-sentence";
import { OutcomePanel } from "./outcome-panel";
import { PoolSelect } from "./pool-select";
import { usePoolYield } from "./use-pool-yield";
import { useRwaPairs } from "./use-rwa-pairs";

const FIELDS: readonly IntentField[] = ["amount", "days", "lossAlert", "exitAsset"];
const DEFAULT_FIELD: IntentField = "amount";
const shortId = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

/** `?edit=` picks the open editor. Retired values from the goal-first layout fall back to the default. */
function fieldFromParam(raw: string | null): IntentField {
  return FIELDS.find((field) => field === raw) ?? DEFAULT_FIELD;
}

function syncPlanUrl(path: string, selection: { poolId?: string; pair?: string; protocol?: string }) {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams(window.location.search);
  if (selection.poolId) next.set("pool", selection.poolId);
  else next.delete("pool");
  if (selection.pair) next.set("pair", selection.pair);
  else next.delete("pair");
  if (selection.protocol) next.set("protocol", selection.protocol);
  else next.delete("protocol");
  const qs = next.toString();
  window.history.replaceState(null, "", qs ? `${path}?${qs}` : path);
}

export function PlanApp() {
  const params = useSearchParams();
  const pathname = usePathname();
  const wallet = useWalletConnection();
  const positionId = parseSolanaAddress(params.get("position"));
  const urlPool = parseSolanaAddress(params.get("pool"));
  const urlPair = parsePairLabel(params.get("pair"));
  const pairs = useRwaPairs();
  const pairRows = pairs.status === "ready" ? pairs.rows : [];
  const fromUrl = resolvePlanSelection({
    poolId: urlPool,
    pair: urlPair,
    pairs: pairRows,
  });
  const [chosen, setChosen] = useState<{ poolId?: string; pair?: string } | null>(null);
  const selection = chosen ?? fromUrl;
  const [setup, setSetup] = useState(() => parsePlanSetup(params));
  const [active, setActive] = useState<IntentField>(() => fieldFromParam(params.get("edit")));
  const [now] = useState(() => Date.now());
  const poolId = selection.poolId;
  const pair = selection.pair;
  const poolYield = usePoolYield(poolId);
  const row = poolId ? pairRows.find((candidate) => candidate.poolAddress === poolId) : undefined;
  // The pool's DEX: the pool list's row, else the link's `protocol` (still loading, or a pool the list no longer has).
  const urlProtocol = poolId && poolId === urlPool ? params.get("protocol") ?? undefined : undefined;
  const protocol = row?.protocol ?? urlProtocol;
  // Per-DEX terms (opening cost, exits, whether the pool opens) come from the pool's descriptor; no protocol branches.
  // Only a pool on the loaded list opens from here.
  const terms = useMemo(() => planPoolTerms({
    descriptor: protocol ? dexDescriptors.descriptorFor(protocol) : null,
    listOpenReason: row
      ? (row.protocol ? openUnavailableReason({ protocol: row.protocol as UnifiedProtocol }) : null)
      : pairs.status === "loading"
        ? "Reading the SoFinance pool list."
        : pairs.status === "ready"
          ? "This pool isn't on the SoFinance pool list, so it can't be opened from here."
          : "The SoFinance pool list could not be read, so this pool can't be opened from here.",
    symbols: row ? [row.wrappedSymbol, row.plainSymbol] : undefined,
  }), [row, protocol, pairs.status]);
  const shownSetup = useMemo(() => ({ ...setup, exitAsset: effectiveExit(setup.exitAsset, terms.exits) }), [setup, terms.exits]);
  const best = poolYield.status === "ready" ? poolYield.best : null;

  useEffect(() => {
    if (!poolId) return;
    syncPlanUrl(pathname, { poolId, pair, protocol });
  }, [pathname, poolId, pair, protocol]);

  const change = (patch: Partial<PlanSetup>) => setSetup((current) => applyPlanChange(current, patch));

  // LP share of the pool fee APR, the DEX's opening cost and the closing cost of the chosen exit (`projectPoolPlan`).
  const exit = shownSetup.exitAsset;
  const comparison = useMemo(() => {
    if (!best) return null;
    return projectPoolPlan({ capital: setup.amount, days: setup.days, window: best, terms, exit });
  }, [setup.amount, setup.days, best, terms, exit]);

  // The same plan at the lowest recent window's APR, so the chart shows the spread of 7 / 30 / 90-day history.
  const lowComparison = useMemo(() => {
    if (!best) return null;
    const low = lowPlanApr(best, best.windows);
    if (!low) return null;
    return projectPoolPlan({ capital: setup.amount, days: setup.days, window: low, terms, exit });
  }, [setup.amount, setup.days, best, terms, exit]);
  // Shares are counted in the pool's stock; from the URL pair label while the pool list is still loading.
  const shareSymbol = planShareSymbol(row ?? pairLabelSymbols(pair));

  const resolvingPair = Boolean(!poolId && pair && pairs.status === "loading");
  const status = resolvingPair ? "loading" : poolYield.status === "idle" ? "idle" : poolYield.status;
  const reason =
    poolYield.status === "unavailable"
      ? poolYield.reason
      : !poolId && pair && pairs.status !== "loading"
        ? "This link names a pair but has no pool id, so there is no yield series to average."
        : undefined;

  const choosePool = (nextId: string) => {
    const resolved = resolvePlanSelection({ poolId: nextId, pairs: pairRows });
    setChosen(resolved);
    syncPlanUrl(pathname, { ...resolved, protocol: pairRows.find((candidate) => candidate.poolAddress === resolved.poolId)?.protocol });
  };

  return (
    <div className="min-h-screen bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pb-16 pt-3 sm:px-5 sm:pt-5">
        <InkNav wallet={wallet.address} connected={wallet.connected} onConnect={wallet.connect} onDisconnect={wallet.disconnect} />

        <main className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-12">
          <section
            aria-labelledby="plan-heading"
            className="animate-rise rounded-[28px] bg-cream p-6 text-ink motion-reduce:animate-none sm:p-9 lg:col-span-12"
          >
            <div className="mb-7 flex flex-wrap items-center justify-between gap-2">
              <h1
                id="plan-heading"
                className="inline-flex h-6 items-center rounded-full border border-ink/70 px-2.5 font-data text-[10px] font-normal uppercase tracking-[0.14em]"
              >
                Plan a position
              </h1>
              {positionId && !poolId ? (
                <span className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
                  Position <span className="normal-case">{shortId(positionId)}</span>
                </span>
              ) : (
                <PoolSelect
                  poolId={poolId}
                  pair={pair}
                  options={pairRows}
                  loading={pairs.status === "loading"}
                  onChange={choosePool}
                />
              )}
            </div>
            <IntentSentence setup={shownSetup} exits={terms.exits} now={now} active={active} onActiveChange={setActive} onChange={change} />
          </section>

          <OutcomePanel
            setup={shownSetup}
            terms={terms}
            status={status}
            reason={reason}
            comparison={comparison}
            best={best}
            poolId={poolId}
          />

          <ComparisonChart
            status={status}
            reason={reason}
            comparison={comparison}
            openCostCopy={terms.openCost.chart}
            shareSymbol={shareSymbol}
            low={lowComparison}
          />
        </main>

        <p className="mt-5 max-w-3xl px-2 text-xs leading-relaxed text-smoke">
          Planning is read-only. Amounts are in USDC; for a same-stock pool the chart also counts shares per 100 held,
          which leaves the stock’s own price out. The projection uses the best of this pool’s 7, 30 and 90-day
          average complete-UTC-day yields with daily auto-compounding. That is the optimistic end of recent
          history, not a forecast.{" "}
          <Link href={APP_ROUTES.positionPerformance} className="text-cream/80 underline underline-offset-2 hover:text-cream">
            See what is verified for an existing position
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
