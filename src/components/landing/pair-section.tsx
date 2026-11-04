"use client";

import { useEffect, useRef, useState } from "react";
import { SAMPLE_ROWS } from "./landing-sample";
import { interpolate, signedPct, useInView, useReducedMotion } from "./use-landing-motion";
import { LandingSectionHeading } from "./section-heading";

const HOODX_START = SAMPLE_ROWS[0]![1];
/** HOODx price change from the start, in percent, by hour. */
const HOODX_PATH = SAMPLE_ROWS.map(([h, price]) => [h, (price / HOODX_START - 1) * 100] as const);
const HOURS = SAMPLE_ROWS[SAMPLE_ROWS.length - 1]![0];
/** One pass over the 24h path, in ms. */
const LOOP_MS = 9000;

const STEPS = [
  {
    n: "01",
    title: "Same underlying",
    body: "Both tokens represent the same stock. When the stock goes up or down, both go up or down together.",
  },
  {
    n: "02",
    title: "Traders swap between them",
    body: "People move between the two versions to switch issuer, venue or wallet. Each swap pays the pool's fee.",
  },
  {
    n: "03",
    title: "Your position collects a share",
    body: "Liquidity whose range covers the current price shares those fees. You keep exposure to the stock the whole time.",
  },
] as const;

function Token({ symbol, issuer, tone, lift }: { symbol: string; issuer: string; tone: "ink" | "lilac"; lift: number }) {
  return (
    <div className="will-change-transform" style={{ transform: `translateY(${lift.toFixed(1)}px)` }} data-testid="pair-token">
      <div
        className={`grid h-[104px] w-[104px] shrink-0 place-items-center rounded-full text-center text-lg font-semibold tracking-[-0.02em] sm:h-32 sm:w-32 sm:text-[22px] ${
          tone === "ink" ? "bg-ink text-cream" : "bg-lilac text-ink"
        }`}
      >
        <span>
          {symbol}
          <small className="mt-1 block font-data text-[8.5px] font-normal uppercase tracking-[0.06em] sm:text-[9.5px] sm:tracking-[0.1em] opacity-70">{issuer}</small>
        </span>
      </div>
    </div>
  );
}

/** "Two tokens. One stock.": both tokens ride the real HOODx 24h path together while the pair price stays at ≈1:1. */
export function PairSection() {
  const reduce = useReducedMotion();
  const visualRef = useRef<HTMLDivElement>(null);
  const inView = useInView(visualRef, 0);
  // Server HTML and reduced motion show the end of the window; with motion the loop starts at 0 once on screen.
  const [loopU, setU] = useState(0);
  const u = reduce === false ? loopU : 1;

  useEffect(() => {
    if (reduce !== false || !inView) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      setU(((now - t0) / LOOP_MS) % 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reduce, inView]);

  const change = interpolate(HOODX_PATH, HOURS * u);
  const lift = -change * 4.2;
  const price = HOODX_START * (1 + change / 100);

  return (
    <section id="pair" className="scroll-mt-6" data-testid="landing-pair">
      <LandingSectionHeading label="The pair" title="Two tokens. One stock.">
        A same-stock pool pairs two tokens of the same stock from two issuers, like HOODx and HOOD. Both track the
        same share price, so they trade close to 1:1 with each other.
      </LandingSectionHeading>
      <div className="grid gap-3 md:grid-cols-[1.15fr_1fr]">
        <div ref={visualRef} className="flex flex-col justify-between rounded-[28px] bg-cream p-6 text-ink sm:p-7 md:min-h-[340px]">
          <span className="font-data text-[11px] uppercase tracking-[0.12em] opacity-60">Example pool · Raydium CLMM · Solana</span>
          <div className="my-6 flex items-center justify-center gap-2.5 sm:gap-[18px]">
            <Token symbol="HOODx" issuer="xStocks token" tone="ink" lift={lift} />
            <p className="shrink-0 text-center font-data text-[11px] leading-tight sm:text-[15px]">
              <b className="mb-0.5 block whitespace-nowrap text-[20px] font-medium tracking-[-0.03em] sm:text-[30px]">≈ 1:1</b>
              same share
              <br className="sm:hidden" /> price
            </p>
            <Token symbol="HOOD" issuer="Backpack Securities" tone="lilac" lift={lift} />
          </div>
          <div className="mb-[18px] grid grid-cols-2 gap-2.5">
            <div className="rounded-[14px] bg-ink/[0.06] px-3.5 py-3">
              <span className="block font-data text-[10px] uppercase tracking-[0.12em] opacity-60">Stock price (HOODx, USD)</span>
              <b className="mr-2 text-[19px] font-medium tabular-nums tracking-[-0.03em] sm:text-2xl" data-testid="pair-price">
                ${price.toFixed(2)}
              </b>
              <em className={`font-data text-xs not-italic ${change >= 0 ? "text-[#178a5e]" : "text-[#c84a2f]"}`}>{signedPct(change)}</em>
            </div>
            <div className="rounded-[14px] bg-ink/[0.06] px-3.5 py-3">
              <span className="block font-data text-[10px] uppercase tracking-[0.12em] opacity-60">HOODx / HOOD</span>
              <b className="mr-2 text-[19px] font-medium tracking-[-0.03em] sm:text-2xl">≈ 1 : 1</b>
              <em className="font-data text-xs not-italic text-[#178a5e]">in range all 24h</em>
            </div>
          </div>
          <div className="flex justify-center">
            <span className="w-[70%] border-t border-ink/30 pt-2.5 text-center font-data text-[11px] uppercase tracking-[0.12em]">
              Underlying: Robinhood Markets stock · real 24h path, Oct 28–29
            </span>
          </div>
        </div>
        <ol className="grid gap-3 md:grid-rows-3">
          {STEPS.map((step) => (
            <li key={step.n} className="rounded-[28px] border border-white/12 bg-char p-6 sm:p-7">
              <h3 className="flex items-baseline gap-3 text-lg font-medium tracking-[-0.02em]">
                <span className="font-data text-[13px] text-lemon">{step.n}</span>
                {step.title}
              </h3>
              <p className="mt-2.5 text-[15px] leading-6 text-cream/65">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
