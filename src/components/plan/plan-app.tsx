"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Decimal from "decimal.js";
import { parseDays, parseUsdc, type Intent, type IntentGoal } from "@/lib/lp-intent";
import { parsePairLabel, parseSolanaAddress } from "@/lib/lp-plan-selection";
import { buildPlanComparison } from "@/lib/lp-plan-yield";
import { APP_ROUTES } from "@/lib/public-urls";
import { InkNav } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { ComparisonChart } from "./comparison-chart";
import { IntentSentence, type IntentField } from "./intent-sentence";
import { RealityCheck } from "./outlook";
import { usePoolYield } from "./use-pool-yield";

const DEFAULT_INTENT: Intent = {
  days: 30,
  amount: "1000",
  goal: "net-by-date",
  target: "30",
  lossAlert: "50",
  exitAsset: "usdc",
};

const FIELDS: readonly IntentField[] = ["days", "amount", "goal", "target", "lossAlert", "exitAsset"];
const GOALS: readonly IntentGoal[] = ["net-by-date", "take-profit", "beat-holding"];
const shortId = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

function shareOfAmount(amount: string, pct: number): string {
  const share = new Decimal(amount).mul(pct).div(100).toDecimalPlaces(2);
  return share.isZero() ? amount : share.toFixed();
}

// Other pages can link in with a plan already filled out, e.g. ?amount=2000&days=60.
// Anything missing or malformed falls back to the default for that field.
function intentFromParams(params: URLSearchParams): Intent {
  const amount = parseUsdc(params.get("amount") ?? "") ?? DEFAULT_INTENT.amount;
  const goal = params.get("goal") as IntentGoal | null;
  return {
    days: parseDays(params.get("days") ?? "") ?? DEFAULT_INTENT.days,
    amount,
    goal: goal && GOALS.includes(goal) ? goal : DEFAULT_INTENT.goal,
    target: parseUsdc(params.get("target") ?? "") ?? shareOfAmount(amount, 3),
    lossAlert: parseUsdc(params.get("alert") ?? "", amount) ?? shareOfAmount(amount, 5),
    exitAsset: params.get("exit") === "tokens" ? "tokens" : "usdc",
  };
}

function PoolCaption({ poolId, pair, positionId }: { poolId?: string; pair?: string; positionId?: string }) {
  const label = pair && poolId ? "Pool" : poolId ? "Pool" : positionId ? "Position" : pair ? "Pair" : null;
  const value = pair && poolId ? pair : poolId ? shortId(poolId) : positionId ? shortId(positionId) : pair;
  return (
    <span className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
      {label ? (
        <>
          {label} <span className="normal-case">{value}</span>
          {pair && !poolId ? " — no pool id" : null}
        </>
      ) : (
        "No pool chosen yet"
      )}
    </span>
  );
}

export function PlanApp() {
  const params = useSearchParams();
  const wallet = useWalletConnection();
  const positionId = parseSolanaAddress(params.get("position"));
  const poolId = parseSolanaAddress(params.get("pool"));
  const pair = parsePairLabel(params.get("pair"));
  const edit = params.get("edit") as IntentField | null;

  const [intent, setIntent] = useState(() => intentFromParams(params));
  const [active, setActive] = useState<IntentField>(edit && FIELDS.includes(edit) ? edit : "target");
  const [now] = useState(() => Date.now());
  const poolYield = usePoolYield(poolId);

  const change = (patch: Partial<Intent>) =>
    setIntent((current) => {
      const next = { ...current, ...patch };
      // The alert can never sit below losing everything that was put in.
      return new Decimal(next.lossAlert).gt(next.amount) ? { ...next, lossAlert: next.amount } : next;
    });

  const comparison = useMemo(() => {
    if (poolYield.status !== "ready") return null;
    return buildPlanComparison({
      capital: intent.amount,
      days: intent.days,
      aprPct: poolYield.aprPct,
      sampleDays: poolYield.sampleDays,
      target: intent.target,
    });
  }, [intent.amount, intent.days, intent.target, poolYield]);

  const status = poolYield.status === "idle" ? "idle" : poolYield.status;
  const reason =
    poolYield.status === "unavailable"
      ? poolYield.reason
      : !poolId && pair
        ? "This link names a pair but has no pool id, so there is no yield series to average."
        : undefined;

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
              <PoolCaption poolId={poolId} pair={pair} positionId={positionId} />
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
