"use client";

export function ConnectWalletPrompt({ onConnect }: { onConnect: () => void }) {
  return <div className="rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5">
    <p className="text-sm leading-6 text-cream/80">Connect your wallet to find your liquidity positions.</p>
    <button type="button" onClick={onConnect} className="mt-3 rounded-xl border border-white/25 px-4 py-2.5 text-sm font-semibold text-cream transition-colors hover:border-white/50 hover:bg-white/[0.04]">Connect wallet</button>
  </div>;
}
