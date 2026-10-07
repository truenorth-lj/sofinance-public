"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Wallet } from "lucide-react";
import { INK_COLORS } from "./ink-tokens";

interface NavLink {
  href: string;
  label: string;
}

interface InkNavProps {
  subtitle: string;
  navLinks?: NavLink[];
  walletAddress?: string | null;
  onWalletConnect?: () => void;
  onWalletDisconnect?: () => void;
  showWallet?: boolean;
}

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

export function InkNav({ 
  subtitle, 
  navLinks = [], 
  walletAddress,
  onWalletConnect,
  onWalletDisconnect,
  showWallet = false
}: InkNavProps) {
  const pathname = usePathname();
  
  return (
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-70">
        <Image 
          src="/logo.png" 
          alt="SoFinance" 
          width={40} 
          height={40}
          className="flex-shrink-0 rounded-lg"
        />
        <div>
          <div className={`text-sm font-bold tracking-wide text-${INK_COLORS.textPrimary}`}>
            SoFinance
          </div>
          <div className={`text-xs text-${INK_COLORS.textTertiary}`}>
            {subtitle}
          </div>
        </div>
      </Link>
      
      <div className="flex items-center gap-2">
        {navLinks.length > 0 && navLinks.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                isActive 
                  ? `border-${INK_COLORS.textPrimary} bg-${INK_COLORS.cardBg} text-${INK_COLORS.textPrimary}`
                  : `border-${INK_COLORS.cardBorder} bg-transparent text-${INK_COLORS.textSecondary} hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`
              }`}
            >
              {link.label}
            </Link>
          );
        })}
        
        {showWallet && (
          walletAddress ? (
            <button 
              onClick={onWalletDisconnect}
              className={`max-w-[160px] inline-flex items-center justify-center gap-2 rounded-xl border border-${INK_COLORS.buttonBorder} bg-transparent px-3 py-2 text-xs font-semibold text-${INK_COLORS.textSecondary} transition-colors hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`}
            >
              <Wallet className="h-4 w-4" />
              {short(walletAddress)}
            </button>
          ) : (
            <button 
              onClick={onWalletConnect}
              className={`inline-flex items-center justify-center gap-2 rounded-xl border border-${INK_COLORS.buttonBorder} bg-transparent px-3 py-2 text-xs font-semibold text-${INK_COLORS.textSecondary} transition-colors hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`}
            >
              <Wallet className="h-4 w-4" />
              Connect wallet
            </button>
          )
        )}
      </div>
    </header>
  );
}
