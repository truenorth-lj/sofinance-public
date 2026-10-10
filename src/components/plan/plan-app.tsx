"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { parseDays, parseUsdc, type Intent, type IntentGoal } from "@/lib/lp-intent";
import {
  applyIntentChange,
  DEFAULT_PLAN_AMOUNT,
  DEFAULT_PLAN_DAYS,
  DEFAULT_PLAN_LOSS_ALERT,
  DEFAULT_PLAN_LOSS_ALERT_PCT,
  DEFAULT_PLAN_TARGET_PCT,
  shareOfAmount,
} from "@/lib/lp-plan-intent";
import {
  formatPlanPoolOption,
  parsePairLabel,
  parseSolanaAddress,
  resolvePlanSelection,
  type PlanPairOption,
} from "@/lib/lp-plan-selection";
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
import { APP_ROUTES } from "@/lib/public-urls";
import { InkNav } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { ComparisonChart } from "./comparison-chart";
import { IntentSentence, type IntentField } from "./intent-sentence";
import { RealityCheck } from "./outlook";
import { usePoolYield } from "./use-pool-yield";
import { useRwaPairs } from "./use-rwa-pairs";

const DEFAULT_INTENT: Intent = {
  days: DEFAULT_PLAN_DAYS,
  amount: DEFAULT_PLAN_AMOUNT,
  goal: "net-by-date",
  target: shareOfAmount(DEFAULT_PLAN_AMOUNT, DEFAULT_PLAN_TARGET_PCT),
  lossAlert: DEFAULT_PLAN_LOSS_ALERT,
  exitAsset: "usdc",
};

const FIELDS: readonly IntentField[] = ["days", "amount", "goal", "target", "lossAlert", "exitAsset"];
const GOALS: readonly IntentGoal[] = ["net-by-date", "take-profit", "beat-holding"];
const shortId = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

function intentFromParams(params: URLSearchParams): Intent {
  const amount = parseUsdc(params.get("amount") ?? "") ?? DEFAULT_INTENT.amount;
  const goal = params.get("goal") as IntentGoal | null;
  return {
    days: parseDays(params.get("days") ?? "") ?? DEFAULT_INTENT.days,
    amount,
    goal: goal && GOALS.includes(goal) ? goal : DEFAULT_INTENT.goal,
    target: parseUsdc(params.get("target") ?? "") ?? shareOfAmount(amount, DEFAULT_PLAN_TARGET_PCT),
    lossAlert: parseUsdc(params.get("alert") ?? "", amount) ?? shareOfAmount(amount, DEFAULT_PLAN_LOSS_ALERT_PCT),
    exitAsset: params.get("exit") === "tokens" ? "tokens" : "usdc",
  };
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

function PoolSelect({
  poolId,
  pair,
  options,
  loading,
  onChange,
}: {
  poolId?: string;
  pair?: string;
  options: readonly PlanPairOption[];
  loading: boolean;
  onChange: (poolId: string) => void;
}) {
  const currentLabel = pair ?? (poolId ? shortId(poolId) : "Choose a pool");
  const known = options.some((row) => row.poolAddress === poolId);
  return (
    <label className="inline-flex max-w-full items-center gap-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
      Pool
      <select
        aria-label="Pool"
        value={poolId ?? ""}
        disabled={loading && options.length === 0 && !poolId}
        onChange={(event) => onChange(event.target.value)}
        className="normal-case max-w-[min(100%,22rem)] truncate rounded-full border border-ink/20 bg-transparent px-2.5 py-1 font-data text-[10px] tracking-[0.08em] text-ink outline-none focus-visible:border-ink"
      >
        {!poolId ? <option value="">Choose a pool</option> : null}
        {poolId && !known ? <option value={poolId}>{currentLabel}</option> : null}
        {options.map((row) => (
          <option key={row.poolAddress} value={row.poolAddress}>
            {formatPlanPoolOption(row)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PlanApp() {
  const params = useSearchParams();
  const pathname = usePathname();
  const wallet = useWalletConnection();
  const positionId = parseSolanaAddress(params.get("position"));
  const urlPool = parseSolanaAddress(params.get("pool"));
  const urlPair = parsePairLabel(params.get("pair"));
  const edit = params.get("edit") as IntentField | null;
  const pairs = useRwaPairs();
  const pairRows = pairs.status === "ready" ? pairs.rows : [];
  const fromUrl = resolvePlanSelection({
    poolId: urlPool,
    pair: urlPair,
    pairs: pairRows,
  });
  const [chosen, setChosen] = useState<{ poolId?: string; pair?: string } | null>(null);
  const selection = chosen ?? fromUrl;
  const [intent, setIntent] = useState(() => intentFromParams(params));
  const [active, setActive] = useState<IntentField>(edit && FIELDS.includes(edit) ? edit : "target");
  const [now] = useState(() => Date.now());
  const poolId = selection.poolId;
  const pair = selection.pair;
  const poolYield = usePoolYield(poolId);

  useEffect(() => {
    if (!poolId) return;
    syncPlanUrl(pathname, { poolId, pair });
  }, [pathname, poolId, pair]);

  const change = (patch: Partial<Intent>) => setIntent((current) => applyIntentChange(current, patch));

  const comparison = useMemo(() => {
    if (poolYield.status !== "ready") return null;
    return buildPlanComparison({
      capital: intent.amount,
      days: intent.days,
      aprPct: poolYield.aprPct,
      sampleDays: poolYield.sampleDays,
      target: intent.target,
      entryCost: planEntryCost(intent.amount),
    });
  }, [intent.amount, intent.days, intent.target, poolYield]);

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

        <main className="mt-3 grid gap-3 lg:grid-cols-12">
          <section
            aria-labelledby="plan-heading"
            className="animate-rise rounded-[28px] bg-cream p-6 text-ink motion-reduce:animate-none sm:p-9 lg:col-span-8"
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
            <IntentSentence intent={intent} now={now} active={active} onActiveChange={setActive} onChange={change} />
          </section>

          <RealityCheck
            intent={intent}
            status={status}
            reason={reason}
            comparison={comparison}
            poolId={poolId}
            onChange={change}
          />

          <ComparisonChart status={status} reason={reason} comparison={comparison} intent={intent} />
        </main>

        <p className="mt-5 max-w-3xl px-2 text-xs leading-relaxed text-smoke">
          Planning is read-only and priced in USDC. The chart uses this pool’s average complete-UTC-day
          yield with daily auto-compounding. That is an estimate from the past, not a forecast.{" "}
          <Link href={APP_ROUTES.positionPerformance} className="text-cream/80 underline underline-offset-2 hover:text-cream">
            See what is verified for an existing position
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
