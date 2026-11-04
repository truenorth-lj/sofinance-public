"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { OPEN_RANGE_PRESETS } from "@sofinance/engine/open-range-presets";
import { SAMPLE } from "./landing-sample";
import { LandingSectionHeading } from "./section-heading";
import { usd, useInView, useReducedMotion } from "./use-landing-motion";

type RangeId = (typeof OPEN_RANGE_PRESETS)[number]["id"];

/**
 * Per preset: how the same dollars look (band width and liquidity height, % of the axis), fee share per dollar vs
 * Wide (concentrated-liquidity math for a centered range: ~1 / half-width), chance of leaving the range (1-3), and
 * the largest IL while still inside the range, before fees.
 */
const RANGE_FACTS: Record<RangeId, {
  bandPct: number; liquidity: number; feeBar: number; feeShare: string; feeLevel: string; feeNote: string; feeMeter: 1 | 2 | 3;
  risk: 1 | 2 | 3; riskLabel: string; ilBar: number; maxIl: string; note: string;
}> = {
  tight: {
    bandPct: 5, liquidity: 100, feeBar: 100, feeShare: "≈20× Wide", feeLevel: "Highest", feeNote: "≈20× Wide, per $", feeMeter: 3,
    risk: 3, riskLabel: "High", ilBar: 5, maxIl: "≈0.01%",
    note: "For pools where the two tokens hold very close together. Expect to check on it more often.",
  },
  standard: {
    bandPct: 30, liquidity: 45, feeBar: 16.7, feeShare: "≈3.3× Wide", feeLevel: "Medium", feeNote: "≈3.3× Wide, per $", feeMeter: 2,
    risk: 2, riskLabel: "Medium", ilBar: 30, maxIl: "≈0.07%", note: "",
  },
  wide: {
    bandPct: 100, liquidity: 16, feeBar: 5, feeShare: "1× (baseline)", feeLevel: "Lower", feeNote: "baseline", feeMeter: 1,
    risk: 1, riskLabel: "Low", ilBar: 100, maxIl: "≈0.25%",
    note: "More room if the two tokens drift apart for a while. Fewer fees per dollar while in range.",
  },
};

/** The real presets, narrow to wide: name ("Tight") and half-width ("±0.05%") from the app's own list. */
export const LANDING_RANGES = OPEN_RANGE_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.label.replace(/\s*\(.*\)$/, ""),
  band: `±${preset.percentBps / 100}%`,
  halfWidthPct: preset.percentBps / 100,
  isDefault: preset.default,
  ...RANGE_FACTS[preset.id],
}));

/** Illustrative price wobble for the explorer (labelled on the page as not data), in % of the pool price. */
const wobble = (seconds: number) => 0.13 * Math.sin(seconds * 1.9) + 0.06 * Math.sin(seconds * 4.3 + 1);
const AUTO_SWITCH_MS = 2800;

function Meter({ on, warn, big = false }: { on: number; warn?: boolean; big?: boolean }) {
  return (
    <span className={big ? "mt-3 flex gap-1" : "mr-2 inline-flex gap-[3px] align-middle"} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          className={`${big ? "h-2.5 flex-1 transition-colors duration-500 motion-reduce:transition-none" : "h-2 w-3"} rounded-[2px] ${
            i < on ? (warn ? "bg-coral group-data-[tone=cream]:bg-[#d9583c]" : "bg-lemon group-data-[tone=cream]:bg-ink") : "bg-current opacity-15"
          }`}
        />
      ))}
    </span>
  );
}

function RangeExplorer() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, 0.4);
  const [current, setCurrent] = useState<RangeId>("standard");
  const [auto, setAuto] = useState(true);
  const [price, setPrice] = useState(0);

  useEffect(() => {
    if (reduce !== false || !inView) return;
    let raf = 0;
    const t0 = performance.now();
    let lastSwitch = t0;
    const step = (now: number) => {
      setPrice(wobble((now - t0) / 1000));
      if (auto && now - lastSwitch > AUTO_SWITCH_MS) {
        lastSwitch = now;
        setCurrent((id) => {
          const i = LANDING_RANGES.findIndex((r) => r.id === id);
          return LANDING_RANGES[(i + 1) % LANDING_RANGES.length]!.id;
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reduce, inView, auto]);

  const range = LANDING_RANGES.find((r) => r.id === current) ?? LANDING_RANGES[1]!;
  const out = Math.abs(price) > range.halfWidthPct;
  const ease = "transition-[width,height,background-color,border-color,opacity] duration-700 ease-[cubic-bezier(.2,.7,.2,1)] motion-reduce:transition-none";

  return (
    <div ref={ref} className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7" data-testid="range-explorer">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5 rounded-full bg-white/[0.06] p-1" role="tablist" aria-label="Range">
          {LANDING_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={r.id === current}
              onClick={() => {
                setAuto(false);
                setCurrent(r.id);
              }}
              className={`rounded-full px-2.5 py-2 text-[13px] transition-colors sm:px-4 sm:text-sm ${
                r.id === current ? "bg-lemon text-ink" : "text-cream hover:bg-white/[0.06]"
              }`}
            >
              {r.name}
              <small className="ml-1 hidden font-data text-[11px] opacity-60 sm:inline">{r.band}</small>
            </button>
          ))}
        </div>
        <span
          role="status"
          className={`rounded-full px-3 py-1.5 font-data text-[11px] uppercase tracking-[0.12em] ${
            out ? "bg-coral/20 text-coral" : "bg-mint/15 text-mint"
          }`}
        >
          {out ? "Out of range · no fees" : "In range · collecting fees"}
        </span>
      </div>
      <div
        className="relative mt-7 h-[150px] border-b border-white/20 bg-[length:12.5%_100%] bg-[linear-gradient(90deg,rgba(244,240,230,.07)_1px,transparent_1px)]"
        aria-hidden="true"
      >
        <div
          className={`absolute inset-y-0 left-1/2 -translate-x-1/2 border-x border-dashed ${ease} ${
            out ? "border-coral/70 bg-coral/[0.08]" : "border-mint/60 bg-mint/10"
          }`}
          style={{ width: `${range.bandPct}%` }}
        >
          <div className={`absolute inset-x-0 bottom-0 rounded-t-md bg-lemon ${ease} ${out ? "opacity-35" : ""}`} style={{ height: `${range.liquidity}%` }} />
        </div>
        <div className="absolute -bottom-2 -top-2 w-0.5 bg-cream" style={{ left: `${50 + price * 50}%` }}>
          <span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap font-data text-[10px] text-cream">price</span>
        </div>
        <div className="absolute inset-x-0 -bottom-[22px] flex justify-between font-data text-[10px] text-smoke">
          <span>−1%</span>
          <span>−0.5%</span>
          <span>0</span>
          <span>+0.5%</span>
          <span>+1%</span>
        </div>
      </div>
      <p className="mt-9 text-[12.5px] text-smoke">Same dollars in each range. Price movement here is illustrative, not data.</p>
      <div className="mt-[18px] grid gap-[22px] border-t border-white/10 pt-[18px] md:grid-cols-3">
        <div>
          <span className="block font-data text-[10px] uppercase tracking-[0.12em] text-smoke">Fee share per $ while in range</span>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/[0.08]">
            <i className={`block h-full rounded-full bg-lemon ${ease}`} style={{ width: `${range.feeBar}%` }} />
          </div>
          <b className="mt-2 block text-xl font-medium tracking-[-0.02em]">{range.feeShare}</b>
        </div>
        <div>
          <span className="block font-data text-[10px] uppercase tracking-[0.12em] text-smoke">Chance of leaving range</span>
          <Meter on={range.risk} warn big />
          <b className="mt-2 block text-xl font-medium tracking-[-0.02em]">{range.riskLabel}</b>
        </div>
        <div>
          <span className="block font-data text-[10px] uppercase tracking-[0.12em] text-smoke">Max IL inside range</span>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/[0.08]">
            <i className={`block h-full rounded-full bg-coral ${ease}`} style={{ width: `${range.ilBar}%` }} />
          </div>
          <b className="mt-2 block text-xl font-medium tracking-[-0.02em]">{range.maxIl} before fees</b>
        </div>
      </div>
    </div>
  );
}

function RangeCard({ range }: { range: (typeof LANDING_RANGES)[number] }) {
  const cream = range.isDefault;
  const rule = cream ? "border-ink/12" : "border-white/10";
  // Bar: the same dollars, concentrated (not to scale). Width = band on a ±1% axis; height grows as the band narrows.
  const fill = { tight: "h-full w-[2.5%]", standard: "h-[62%] w-[15%]", wide: "h-[20%] w-1/2" }[range.id];
  return (
    <article
      data-tone={cream ? "cream" : "dark"}
      data-testid={`range-card-${range.id}`}
      className={`group flex flex-col rounded-[28px] p-6 sm:p-7 ${cream ? "bg-cream text-ink max-md:order-first" : "border border-white/12 bg-char"}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[26px] font-medium tracking-[-0.03em]">
          {range.name}
          {range.isDefault && (
            <span className="ml-2 rounded-full bg-ink px-2 py-1 align-middle font-data text-[10px] uppercase tracking-[0.12em] text-lemon">Default</span>
          )}
        </h3>
        <span className={`rounded-full px-2.5 py-1 font-data text-[13px] ${cream ? "bg-ink/[0.08]" : "bg-white/[0.08]"}`}>{range.band}</span>
      </div>
      <div
        className={`relative mb-1.5 mt-[22px] h-[54px] rounded-[10px] bg-[length:10%_100%] ${
          cream ? "bg-[linear-gradient(90deg,rgba(13,13,12,.1)_1px,transparent_1px)]" : "bg-[linear-gradient(90deg,rgba(244,240,230,.09)_1px,transparent_1px)]"
        }`}
        aria-hidden="true"
      >
        <div className={`absolute bottom-0 left-1/2 -translate-x-1/2 rounded-lg bg-lemon ${fill}`} />
        <div className={`absolute -bottom-1.5 -top-1.5 left-1/2 w-0.5 ${cream ? "bg-ink" : "bg-cream"}`} />
      </div>
      <div className="flex justify-between font-data text-[10px] opacity-55">
        <span>−1%</span>
        <span>pool price</span>
        <span>+1%</span>
      </div>
      <dl className="mt-5">
        <div className={`grid grid-cols-[1fr_auto] items-baseline gap-3 border-t py-3 ${rule}`}>
          <dt className="text-sm opacity-70">Fee share while in range</dt>
          <dd className="text-right text-[15px] font-semibold">
            <Meter on={range.feeMeter} />
            {range.feeLevel}
            <small className="mt-0.5 block font-data text-[11.5px] font-normal opacity-65">{range.feeNote}</small>
          </dd>
        </div>
        <div className={`grid grid-cols-[1fr_auto] items-baseline gap-3 border-t py-3 ${rule}`}>
          <dt className="text-sm opacity-70">Chance of leaving range</dt>
          <dd className="text-right text-[15px] font-semibold">
            <Meter on={range.risk} warn />
            {range.riskLabel}
          </dd>
        </div>
        <div className={`grid grid-cols-[1fr_auto] items-baseline gap-3 border-t py-3 ${rule}`}>
          <dt className="text-sm opacity-70">Max IL inside range</dt>
          <dd className="text-right text-[15px] font-semibold">
            {range.maxIl}
            <small className="mt-0.5 block font-data text-[11.5px] font-normal opacity-65">before fees</small>
          </dd>
        </div>
      </dl>
      {range.id === "standard" ? (
        <div className="mt-auto pt-[18px]">
          <div className="rounded-2xl bg-ink p-4 text-cream" data-testid="range-sample">
            <span className="font-data text-[10px] uppercase tracking-[0.12em] text-lemon">
              Simulated $1,000 · HOODx/HOOD · 24h · real pool data
            </span>
            <div className="mt-2.5 flex gap-[22px]">
              <div>
                <b className="block text-2xl font-medium tracking-[-0.03em]">{usd(SAMPLE.feesUsd)}</b>
                <span className="text-xs opacity-65">fees collected</span>
              </div>
              <div>
                <b className="block text-2xl font-medium tracking-[-0.03em]">+{usd(SAMPLE.diffUsd)}</b>
                <span className="text-xs opacity-65">vs just holding</span>
              </div>
            </div>
            <p className="mt-2.5 text-[11.5px] leading-[1.45] opacity-60">
              Oct 28–29, 2026. No real deposit. Includes the 0.1% entry fee; slippage, network and closing costs not
              modelled. Not a prediction.
            </p>
          </div>
        </div>
      ) : (
        <p className={`mt-auto pt-[18px] text-[13.5px] leading-[1.55] ${cream ? "text-ink/60" : "text-cream/60"}`}>{range.note}</p>
      )}
    </article>
  );
}

/** "Pick your range": an explorer that cycles Tight / Standard / Wide, then one card per preset. */
export function RangesSection({ cta }: { cta: ReactNode }) {
  return (
    <section id="ranges" className="scroll-mt-6" data-testid="landing-ranges">
      <LandingSectionHeading label="Ranges" title="Narrower range, bigger fee share. Wider range, more room to move.">
        You choose how far around the current price your liquidity sits. Your position only collects fees while the
        pool price is inside that range.
      </LandingSectionHeading>
      <RangeExplorer />
      <div className="mt-3 grid items-stretch gap-3 md:grid-cols-3">
        {LANDING_RANGES.map((range) => (
          <RangeCard key={range.id} range={range} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-5 px-2">
        <p className="max-w-[78ch] text-[13.5px] leading-[1.55] text-cream/60">
          Out of range in any preset: the position collects no fees until price returns or you change range. SoFinance
          does not move your range for you. On Solana the app suggests a range for each pool, picked from the past 7
          days of fee data, and also offers Micro and Custom.
        </p>
        {cta}
      </div>
      <p className="mt-3.5 max-w-[110ch] px-2 text-[12.5px] leading-[1.6] text-smoke">
        Fee share and max IL are concentrated-liquidity math for a centered range, not pool data. Fee share compares
        liquidity per dollar against Wide. Bar heights illustrate how the same dollars concentrate; not to scale.
      </p>
    </section>
  );
}
