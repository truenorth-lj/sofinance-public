"use client";

import type { ReactNode } from "react";
import { parseDays, parseUsdc, type ExitAsset } from "@/lib/lp-intent";
import { percentOfAmount, shareOfAmount, type PlanSetup } from "@/lib/lp-plan-intent";
import { daysWord, formatAmount, formatCompact, formatPct, formatUtcDate } from "./format";
import { Editor, OptionCard, Pill, ValueField, type IntentField, type PillTone } from "./plan-controls";
import { Ruler } from "./ruler";

export type { IntentField } from "./plan-controls";

const DAY_MS = 86_400_000;
const DAY_STOPS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 150, 180, 240, 300, 365] as const;
const AMOUNT_STOPS = [
  50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000,
] as const;
const LOSS_PCT_STOPS = [0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75, 100] as const;

const EXITS: Record<ExitAsset, { label: string; title: string; detail: string }> = {
  usdc: {
    label: "USDC",
    title: "Back to USDC",
    detail: "Swap both tokens back. Today's exit preview returns USDC plus a small SOL rent refund.",
  },
  tokens: {
    label: "the original tokens",
    title: "Keep the tokens",
    detail: "Skip the swap. You stay exposed to the tokens' price after leaving the pool.",
  },
};

/**
 * "I'll put in [1,000 USDC] for [30 days]." with an optional second line for the loss alert and
 * exit asset, plus the editor for whichever pill is active.
 */
export function IntentSentence({
  setup,
  now,
  active,
  onActiveChange,
  onChange,
}: {
  setup: PlanSetup;
  now: number;
  active: IntentField;
  onActiveChange: (field: IntentField) => void;
  onChange: (patch: Partial<PlanSetup>) => void;
}) {
  const pill = (field: IntentField, tone: PillTone, content: ReactNode) => (
    <Pill field={field} tone={tone} active={active === field} onSelect={onActiveChange}>
      {content}
    </Pill>
  );
  const lossPct = percentOfAmount(setup.lossAlert, setup.amount);

  return (
    <div>
      <p className="text-[clamp(1.8rem,3.7vw,3.05rem)] font-medium leading-[1.36] tracking-[-0.035em]">
        I&apos;ll put in {pill("amount", "lemon", `${formatAmount(setup.amount)} USDC`)} for{" "}
        {pill("days", "lilac", `${setup.days} ${daysWord(setup.days)}`)}.
      </p>
      <p className="mt-5 text-[clamp(1.05rem,1.7vw,1.4rem)] font-medium leading-[1.6] tracking-[-0.02em] text-ink/75">
        <span className="mr-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/50">Optional</span>
        Warn me if I&apos;m down {pill("lossAlert", "coral", `${formatAmount(setup.lossAlert)} USDC`)}, and exit to{" "}
        {pill("exitAsset", "white", EXITS[setup.exitAsset].label)}.
      </p>

      <div id="plan-editor" key={active} className="mt-8 border-t border-ink/15 pt-6">
        {active === "amount" && (
          <Editor
            eyebrow="What you'd put in"
            note="Sized in USDC for the analysis. Nothing is deposited or signed from this page."
          >
            <ValueField
              label="Amount to put in, in USDC"
              unit="USDC"
              value={setup.amount}
              display={formatAmount(setup.amount)}
              parse={(text) => parseUsdc(text)}
              onCommit={(amount) => onChange({ amount })}
            />
            <Ruler
              label="Amount to put in"
              stops={AMOUNT_STOPS}
              majors={[100, 1000, 10000, 100000]}
              value={Number(setup.amount)}
              valueText={`${formatAmount(setup.amount)} USDC`}
              onChange={(amount) => onChange({ amount: String(amount) })}
              formatStop={formatCompact}
              knobClassName="bg-lemon"
            />
          </Editor>
        )}

        {active === "days" && (
          <Editor
            eyebrow="How long it stays in"
            note={
              <>
                Type any whole number of days from 1 to 365, or slide. Ends{" "}
                <span suppressHydrationWarning>{formatUtcDate(now + setup.days * DAY_MS)}</span> (UTC). A planning
                horizon, not a lock-up or a promise of profit.
              </>
            }
          >
            <ValueField
              label="Days it stays in"
              unit={daysWord(setup.days)}
              value={String(setup.days)}
              display={String(setup.days)}
              parse={(text) => {
                const days = parseDays(text);
                return days === null ? null : String(days);
              }}
              onCommit={(value) => onChange({ days: Number(value) })}
            />
            <Ruler
              label="Days it stays in"
              stops={DAY_STOPS}
              majors={[7, 30, 90, 180, 365]}
              value={setup.days}
              valueText={`${setup.days} ${daysWord(setup.days)}`}
              onChange={(days) => onChange({ days })}
              formatStop={(days) => `${days}d`}
              knobClassName="bg-lilac"
            />
          </Editor>
        )}

        {active === "lossAlert" && (
          <Editor
            eyebrow="Loss that should get your attention"
            note={`${formatPct(lossPct)} of what you put in. Optional, and it does not change the projection. A line to act on, not a guaranteed floor: gaps and thin liquidity can overshoot it.`}
          >
            <ValueField
              label="Loss alert, in USDC"
              prefix={"−"}
              unit="USDC"
              value={setup.lossAlert}
              display={formatAmount(setup.lossAlert)}
              parse={(text) => parseUsdc(text, setup.amount)}
              onCommit={(lossAlert) => onChange({ lossAlert })}
            />
            <Ruler
              label="Loss alert as a share of the amount"
              stops={LOSS_PCT_STOPS}
              majors={[1, 5, 10, 25, 50, 100]}
              value={lossPct}
              valueText={`${formatAmount(setup.lossAlert)} USDC, ${formatPct(lossPct)} of the amount`}
              onChange={(pct) => onChange({ lossAlert: shareOfAmount(setup.amount, pct) })}
              formatStop={(pct) => `${pct}%`}
              knobClassName="bg-coral"
            />
          </Editor>
        )}

        {active === "exitAsset" && (
          <Editor eyebrow="What you'd take back" note="Optional, and it does not change the projection.">
            <div role="radiogroup" aria-label="What you'd take back" className="mt-4 grid gap-3 sm:grid-cols-2">
              {(Object.keys(EXITS) as ExitAsset[]).map((key) => (
                <OptionCard
                  key={key}
                  selected={setup.exitAsset === key}
                  title={EXITS[key].title}
                  detail={EXITS[key].detail}
                  onSelect={() => onChange({ exitAsset: key })}
                />
              ))}
            </div>
          </Editor>
        )}
      </div>
    </div>
  );
}
