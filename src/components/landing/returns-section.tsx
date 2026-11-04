"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DOCS_ROUTES } from "@/lib/public-urls";
import { SAMPLE, SAMPLE_FOOTNOTE, SAMPLE_GAP_H, SAMPLE_ROWS } from "./landing-sample";
import { LandingSectionHeading } from "./section-heading";
import { interpolate, signedPct, usd, useInView, useReducedMotion } from "./use-landing-motion";

const HOURS = SAMPLE_ROWS[SAMPLE_ROWS.length - 1]![0];
const HOLD = SAMPLE_ROWS.map(([h, , hold]) => [h, hold] as const);
const POOL = SAMPLE_ROWS.map(([h, , , pool]) => [h, pool] as const);
const FEES = SAMPLE_ROWS.map(([h, , , , fees]) => [h, fees] as const);
/** One play of the 24h window, in ms. */
const PLAY_MS = 5200;
const Y_MIN = 990;
const Y_MAX = 1060;
const Y_TICKS = [1000, 1020, 1040, 1060];
const X_TICKS = [0, 6, 12, 18, 24];

type Geo = { w: number; h: number; left: number; right: number; top: number; bottom: number; tick: number; gapLabel: number; dot: number };
/** Desktop and phone layouts of the same chart (the phone one keeps its labels readable at 375px). */
const GEO: Record<"wide" | "narrow", Geo> = {
  wide: { w: 908, h: 400, left: 70, right: 118, top: 18, bottom: 36, tick: 13, gapLabel: 30, dot: 6 },
  narrow: { w: 560, h: 380, left: 64, right: 122, top: 16, bottom: 36, tick: 17, gapLabel: 26, dot: 6 },
};

function scales(g: Geo) {
  const x = (h: number) => g.left + ((g.w - g.left - g.right) * h) / HOURS;
  const y = (v: number) => g.top + ((g.h - g.top - g.bottom) * (Y_MAX - v)) / (Y_MAX - Y_MIN);
  return { x, y };
}

/** Solid segments, and dashed ones across the logging gap (straight lines between the readings either side). */
function paths(g: Geo, points: readonly (readonly [number, number])[]) {
  const { x, y } = scales(g);
  let solid = "";
  let dashed = "";
  for (let i = 1; i < points.length; i++) {
    const [h0, v0] = points[i - 1]!;
    const [h1, v1] = points[i]!;
    const seg = `M${x(h0).toFixed(1)},${y(v0).toFixed(1)}L${x(h1).toFixed(1)},${y(v1).toFixed(1)}`;
    if (h1 - h0 > SAMPLE_GAP_H) dashed += seg;
    else solid += seg;
  }
  return { solid, dashed };
}

function ReturnsChart({ layout, t, className }: { layout: "wide" | "narrow"; t: number; className: string }) {
  const g = GEO[layout];
  const { x, y } = scales(g);
  const hold = paths(g, HOLD);
  const pool = paths(g, POOL);
  const h = HOURS * t;
  const cx = x(h);
  const clipId = `returns-clip-${layout}`;
  const endX = x(HOURS);
  const holdEnd = y(SAMPLE.holdEndUsd);
  const poolEnd = y(SAMPLE.poolEndUsd);
  return (
    <svg
      viewBox={`0 0 ${g.w} ${g.h}`}
      className={className}
      role="img"
      aria-label={`Value of $1,000 over 24 hours: just holding HOODx ends at ${usd(SAMPLE.holdEndUsd)}, the HOODx/HOOD pool position ends at ${usd(SAMPLE.poolEndUsd)}.`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={Math.max(0.001, cx)} height={g.h} />
        </clipPath>
      </defs>
      {Y_TICKS.map((v) => (
        <g key={v}>
          <line x1={g.left} x2={g.w - g.right} y1={y(v)} y2={y(v)} stroke="rgba(244,240,230,.08)" />
          <text x={g.left - 10} y={y(v) + g.tick * 0.3} textAnchor="end" fontSize={g.tick} className="fill-smoke font-data">
            ${v.toLocaleString("en-US")}
          </text>
        </g>
      ))}
      {X_TICKS.map((hh) => (
        <text key={hh} x={x(Math.min(hh, HOURS))} y={g.h - 8} textAnchor={hh === 24 ? "end" : "middle"} fontSize={g.tick} className="fill-smoke font-data">
          {hh}h
        </text>
      ))}
      <g clipPath={`url(#${clipId})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
        <path d={hold.solid} stroke="rgba(244,240,230,.7)" strokeWidth={2.6} />
        <path d={hold.dashed} stroke="rgba(244,240,230,.7)" strokeWidth={2} strokeDasharray="5 6" />
        <path d={pool.solid} stroke="var(--color-mint)" strokeWidth={2.6} />
        <path d={pool.dashed} stroke="var(--color-mint)" strokeWidth={2} strokeDasharray="5 6" />
      </g>
      <g style={{ opacity: t > 0 && t < 1 ? 1 : 0 }}>
        <line x1={cx} x2={cx} y1={g.top} y2={g.h - g.bottom} stroke="rgba(244,240,230,.25)" />
        <circle cx={cx} cy={y(interpolate(HOLD, h))} r={g.dot} fill="var(--color-cream)" stroke="var(--color-canvas)" strokeWidth={2} />
        <circle cx={cx} cy={y(interpolate(POOL, h))} r={g.dot + 1} fill="var(--color-mint)" stroke="var(--color-canvas)" strokeWidth={2} />
      </g>
      <g data-testid="returns-gap" className="transition-opacity duration-300 motion-reduce:transition-none" style={{ opacity: t >= 1 ? 1 : 0 }}>
        <rect x={endX - 5} y={poolEnd} width={10} height={holdEnd - poolEnd} rx={3} fill="var(--color-lemon)" />
        <circle cx={endX} cy={holdEnd} r={g.dot} fill="var(--color-cream)" stroke="var(--color-canvas)" strokeWidth={2} />
        <circle cx={endX} cy={poolEnd} r={g.dot + 1} fill="var(--color-mint)" stroke="var(--color-canvas)" strokeWidth={2} />
        <text x={endX + 14} y={(holdEnd + poolEnd) / 2 + g.gapLabel * 0.3} fontSize={g.gapLabel} fontWeight={600} fill="var(--color-lemon)">
          +{usd(SAMPLE.diffUsd)}
        </text>
      </g>
    </svg>
  );
}

const RISKS = [
  "The two tokens can trade at a premium or discount to each other (depeg).",
  "Issuer or wrapper risk: either token depends on its issuer and redemption terms.",
  "If the ratio drifts out of your range, fees stop and IL grows with the move.",
  "Smart contract, liquidity and Token-2022 / freeze-authority risk on the DEX and the token programs.",
] as const;

/**
 * "IL comes from the ratio moving": a simulated $1,000 in the HOODx/HOOD pool vs just holding HOODx over one real
 * 24h window, drawn once when scrolled into view (replayable), then the low-IL explainer and the risk card.
 */
export function ReturnsSection() {
  const reduce = useReducedMotion();
  const cardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(cardRef, 0.3);
  // Server HTML and reduced motion show the finished chart; with motion it starts empty and draws on first view.
  const [playT, setT] = useState(0);
  const t = reduce === false ? playT : 1;
  const played = useRef(false);
  const raf = useRef(0);

  const play = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (reduce !== false) return;
    const t0 = performance.now();
    const step = (now: number) => {
      const next = Math.min(1, (now - t0) / PLAY_MS);
      setT(next);
      if (next < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [reduce]);

  useEffect(() => {
    if (reduce !== false || !inView || played.current) return;
    played.current = true;
    play();
  }, [reduce, inView, play]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const h = HOURS * t;
  const hold = t >= 1 ? SAMPLE.holdEndUsd : interpolate(HOLD, h);
  const pool = t >= 1 ? SAMPLE.poolEndUsd : interpolate(POOL, h);
  const fees = t >= 1 ? SAMPLE.feesUsd : interpolate(FEES, h);
  const done = t >= 1;

  return (
    <section id="il" className="scroll-mt-6" data-testid="landing-il">
      <LandingSectionHeading label="Impermanent loss" title="IL comes from the ratio moving. Here the ratio barely moves.">
        Impermanent loss is what a pool position gives up versus just holding, when the price between its two tokens
        changes. In a same-stock pool the stock can swing while both tokens move together, so the ratio stays tight.
      </LandingSectionHeading>

      <div ref={cardRef} className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7" data-testid="returns-comparison">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xl font-medium tracking-[-0.02em]">$1,000 for 24 hours: hold vs pool</h3>
          <span className="rounded-full bg-mint/15 px-2.5 py-1 font-data text-[10px] uppercase tracking-[0.12em] text-mint">
            HOODx/HOOD · Standard ±0.3%
          </span>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2.5 sm:gap-4">
          <div className="rounded-[18px] bg-white/[0.04] px-3.5 py-3 sm:px-[18px] sm:py-3.5">
            <p className="flex items-center gap-2.5 font-data text-[10px] uppercase tracking-[0.1em] text-cream/80 sm:text-[11px]">
              <i className="inline-block h-1 w-[18px] rounded-sm bg-cream/70" aria-hidden="true" />
              Hold HOODx
            </p>
            <b className="mt-1.5 block text-[22px] font-medium tabular-nums tracking-[-0.03em] sm:text-[34px]" data-testid="returns-hold">
              {usd(hold)}
            </b>
            <span className="font-data text-[11px] text-smoke sm:text-xs">{signedPct((hold / SAMPLE.depositUsd - 1) * 100)}</span>
          </div>
          <div className="rounded-[18px] bg-mint/[0.07] px-3.5 py-3 sm:px-[18px] sm:py-3.5">
            <p className="flex items-center gap-2.5 font-data text-[10px] uppercase tracking-[0.1em] text-mint sm:text-[11px]">
              <i className="inline-block h-1 w-[18px] rounded-sm bg-mint" aria-hidden="true" />
              Pool position
            </p>
            <b className="mt-1.5 block text-[22px] font-medium tabular-nums tracking-[-0.03em] text-mint sm:text-[34px]" data-testid="returns-pool">
              {usd(pool)}
            </b>
            <span className="font-data text-[11px] text-smoke sm:text-xs">
              {t > 0 ? `${signedPct((pool / SAMPLE.depositUsd - 1) * 100)} · ` : ""}after $1 entry fee
            </span>
          </div>
        </div>
        <ReturnsChart layout="wide" t={t} className="mt-3 hidden w-full md:block" />
        <ReturnsChart layout="narrow" t={t} className="mt-3 block w-full md:hidden" />
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-2 font-data text-[11px] text-smoke sm:text-xs">
          <span>
            Fees collected <b className="font-medium text-cream" data-testid="returns-fees">{usd(fees)}</b> · price in range the whole window
          </span>
          <span className="ml-auto tabular-nums">+{(done ? 24 : h).toFixed(1)}h</span>
        </div>
        <p
          className="mt-4 rounded-[18px] border border-lemon/45 bg-lemon/10 px-4 py-3 text-base leading-snug transition-opacity duration-300 motion-reduce:transition-none sm:text-lg"
          style={{ opacity: done ? 1 : 0 }}
          data-testid="returns-result"
        >
          <b className="font-semibold text-lemon">+{usd(SAMPLE.diffUsd)} vs holding</b>, of which{" "}
          <b className="font-semibold text-lemon">{usd(SAMPLE.feesUsd)}</b> is fees collected.
        </p>
      </div>
      <p className="mt-3.5 max-w-[110ch] px-2 text-[12.5px] leading-[1.6] text-smoke">
        <span data-testid="returns-footnote">{SAMPLE_FOOTNOTE}</span> Oct 28, 18:32 to Oct 29, 18:30, 2026 (UTC+8) ·
        Raydium CLMM HOODx/HOOD, Standard ±0.3% range, price in range the whole window · includes the 0.1% entry fee; slippage,
        network and closing costs not modelled · dashed: logging gap, drawn as a straight line.{" "}
        <button
          type="button"
          onClick={play}
          className="ml-1 rounded-full border border-white/25 px-2.5 py-0.5 text-[11.5px] text-cream hover:border-cream"
        >
          Replay ↻
        </button>
      </p>

      <div className="mt-3 grid gap-3 md:grid-cols-[1.3fr_1fr]">
        <article className="rounded-[28px] bg-cream p-6 text-ink sm:p-7">
          <h3 className="text-xl font-medium tracking-[-0.02em]">Why a flat ratio means low IL</h3>
          <p className="mt-2.5 text-[15.5px] leading-[1.6] text-ink/75">
            A pool position shifts between its two tokens as their price ratio moves. If one token falls against the
            other, the position ends up holding more of the one that fell than you started with. That gap versus
            holding is IL. When both tokens are the same stock, the ratio stays near 1:1 and that gap stays small,
            even on days the stock itself moves several percent.
          </p>
          <p className="mt-4 rounded-xl bg-ink/[0.06] px-3.5 py-3 font-data text-[13px]">
            Largest IL while still inside the range, before fees:
            <br />
            Tight ±0.05% ≈ 0.01% · Standard ±0.3% ≈ 0.07% · Wide ±1% ≈ 0.25%
          </p>
        </article>
        <article className="rounded-[28px] border border-coral/35 bg-coral/10 p-6 sm:p-7" data-testid="landing-risk-card">
          <h3 className="text-xl font-medium tracking-[-0.02em] text-coral">Low is not zero</h3>
          <ul className="mt-3 grid gap-2">
            {RISKS.map((risk) => (
              <li
                key={risk}
                className="relative pl-4 text-[14.5px] leading-normal text-cream/80 before:absolute before:left-0 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-coral"
              >
                {risk}
              </li>
            ))}
          </ul>
          <Link href={DOCS_ROUTES.risks} className="mt-3.5 inline-block border-b border-current pb-px text-sm text-cream">
            Read all risks →
          </Link>
        </article>
      </div>
    </section>
  );
}
