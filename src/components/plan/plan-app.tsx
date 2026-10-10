"use client";

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Decimal from "decimal.js";
import { evaluateIntent, paceToTarget, parseDays, parseUsdc, type Intent, type IntentGoal } from "@/lib/lp-intent";
import { APP_ROUTES } from "@/lib/public-urls";
import { IntentSentence, type IntentField } from "./intent-sentence";
import { RealityCheck, ScenarioCards } from "./outlook";
import { PlanNav } from "./plan-nav";

const DEFAULT_INTENT: Intent = {
  days: 30,
  amount: "1000",
  goal: "net-by-date",
  target: "30",
  lossAlert: "50",
  exitAsset: "usdc",
};

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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

export function PlanApp() {
  const params = useSearchParams();
  const position = params.get("position");
  const positionId = position && ADDRESS.test(position) ? position : undefined;
  const pair = params.get("pair")?.slice(0, 24);
  const edit = params.get("edit") as IntentField | null;

  const [intent, setIntent] = useState(() => intentFromParams(params));
  const [active, setActive] = useState<IntentField>(edit && FIELDS.includes(edit) ? edit : "target");
  const [sample, setSample] = useState(params.get("sample") === "1");
  const [now] = useState(() => Date.now());

  const change = (patch: Partial<Intent>) =>
    setIntent((current) => {
      const next = { ...current, ...patch };
      // The alert can never sit below losing everything that was put in.
      return new Decimal(next.lossAlert).gt(next.amount) ? { ...next, lossAlert: next.amount } : next;
    });

  // Dragging a ruler stays smooth; the sample engine catches up a frame later.
  const settled = useDeferredValue(intent);
  const outlook = useMemo(
    () => (sample ? evaluateIntent(settled, now, positionId) : null),
    [sample, settled, now, positionId],
  );
  const { amount, target, goal } = settled;
  const pace = useMemo(
    () => (sample ? paceToTarget({ ...DEFAULT_INTENT, amount, target, goal }, now, positionId) : null),
    [sample, amount, target, goal, now, positionId],
  );

  return (
    <div className="min-h-screen bg-canvas text-cream">
      <div className="mx-auto max-w-[1280px] px-3 pb-16 pt-3 sm:px-5 sm:pt-5">
        <PlanNav />

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
              <span className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
                {positionId
                  ? `Position ${shortId(positionId)}`
                  : pair
                    ? `Pool ${pair}`
                    : "No pool chosen yet"}
              </span>
            </div>
            <IntentSentence intent={intent} now={now} active={active} onActiveChange={setActive} onChange={change} />
          </section>

          <RealityCheck
            intent={settled}
            outlook={outlook}
            pace={pace}
            sample={sample}
            onSampleChange={setSample}
            onChange={change}
          />

          <ScenarioCards intent={settled} outlook={outlook} />
        </main>

        <p className="mt-5 max-w-3xl px-2 text-xs leading-relaxed text-smoke">
          Planning is read-only and priced in USDC. Fees depend on the path prices take and on trading volume, not only
          on where the price ends, so a real estimate needs verified pool data.{" "}
          <Link href={APP_ROUTES.positionPerformance} className="text-cream/80 underline underline-offset-2 hover:text-cream">
            See what is verified for an existing position
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
