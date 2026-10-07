"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wallet } from "lucide-react";
import { INK_COLORS } from "./ink-tokens";

interface InkNavProps {
  wallet?: string | null;
  connected?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

const NAV_LINKS = [
  { href: "/", label: "Positions" },
  { href: "/position-performance", label: "Position performance" },
  { href: "/rwa-pairs", label: "RWA pairs" },
] as const;

export function InkNav({ wallet, connected, onConnect, onDisconnect }: InkNavProps) {
  const pathname = usePathname();

  return (
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-70">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl border border-${INK_COLORS.logoBorder} bg-${INK_COLORS.logoBg} text-lg font-bold text-${INK_COLORS.textPrimary}`}>
          S
        </div>
        <div>
          <div className={`text-sm font-bold tracking-wide text-${INK_COLORS.textPrimary}`}>
            SoFinance
          </div>
          <div className={`text-xs text-${INK_COLORS.textTertiary}`}>
            Solana · Raydium CLMM
          </div>
        </div>
      </Link>

      <div className="flex items-center gap-2">
        {NAV_LINKS.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                isActive
                  ? `border-${INK_COLORS.buttonBorderHover} bg-${INK_COLORS.buttonBgHover} text-${INK_COLORS.textPrimary}`
                  : `border-${INK_COLORS.cardBorder} bg-transparent text-${INK_COLORS.textSecondary} hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`
              }`}
            >
              {link.label}
            </Link>
          );
        })}

        {onConnect && onDisconnect && (
          <>
            {connected && wallet ? (
              <button
                onClick={onDisconnect}
                className={`max-w-[160px] inline-flex items-center justify-center gap-2 rounded-xl border border-${INK_COLORS.cardBorder} bg-transparent px-3 py-2 text-xs font-semibold text-${INK_COLORS.textSecondary} transition-colors hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`}
              >
                <Wallet className="h-4 w-4" />
                {short(wallet)}
              </button>
            ) : (
              <button
                onClick={onConnect}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border border-${INK_COLORS.cardBorder} bg-transparent px-3 py-2 text-xs font-semibold text-${INK_COLORS.textSecondary} transition-colors hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`}
              >
                <Wallet className="h-4 w-4" />
                Connect wallet
              </button>
            )}
          </>
        )}
      </div>
    </header>
  );
}
