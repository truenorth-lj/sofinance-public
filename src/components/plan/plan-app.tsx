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
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
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

function syncPlanUrl(path: string, selection: { poolId?: string; pair?: string }) {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams(window.location.search);
  if (selection.poolId) next.set("pool", selection.poolId);
  else next.delete("pool");
  if (selection.pair) next.set("pair", selection.pair);
  else next.delete("pair");
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
  const best = poolYield.status === "ready" ? poolYield.best : null;

  useEffect(() => {
    if (!poolId) return;
    syncPlanUrl(pathname, { poolId, pair });
  }, [pathname, poolId, pair]);

  const change = (patch: Partial<PlanSetup>) => setSetup((current) => applyPlanChange(current, patch));

  const comparison = useMemo(() => {
    if (!best) return null;
    return buildPlanComparison({
      capital: setup.amount,
      days: setup.days,
      aprPct: best.aprPct,
      sampleDays: best.sampleDays,
      aprWindowDays: best.windowDays,
      entryCost: planEntryCost(setup.amount),
    });
  }, [setup.amount, setup.days, best]);

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
    syncPlanUrl(pathname, resolved);
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
            <IntentSentence setup={setup} now={now} active={active} onActiveChange={setActive} onChange={change} />
          </section>

          <OutcomePanel
            setup={setup}
            status={status}
            reason={reason}
            comparison={comparison}
            best={best}
            poolId={poolId}
          />

          <ComparisonChart status={status} reason={reason} comparison={comparison} />
        </main>

        <p className="mt-5 max-w-3xl px-2 text-xs leading-relaxed text-smoke">
          Planning is read-only and priced in USDC. The projection uses the best of this pool’s 7, 30 and 90-day
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
