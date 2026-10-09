"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { formatAmount, parseTokenAmount } from "@/lib/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@/lib/ids";
import { quoteIsFresh } from "@/lib/quote-math";
import { OPEN_RANGE_PRESETS, type OpenRangePreset } from "@/lib/open-range-presets";
import { preserveExtraSignatures } from "@/lib/open-signatures";
import { notSentRetryMessage } from "@/lib/public-error";
import type { OpenPositionQuote } from "@/lib/open-types";
import type { WalletAsset, WalletDiscovery } from "@/lib/wallet-discovery";
import { useWalletConnection } from "./wallet-connection";

export type OpenPositionPair = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps: number | null;
  token2022A: boolean;
  token2022B: boolean;
  freezeRisk: boolean;
};

type ApiError = { error: string };
type Prepared = {
  unsignedTransaction: string;
  permit: string;
  summary: {
    operation: "open-position";
    expiresAt: number;
    nftMint: string;
    quote: OpenPositionQuote;
  };
};

export type OpenSubmitStage = "preparing" | "wallet" | "broadcasting" | "confirmed" | null;

function pickInput(assets: WalletAsset[], mintA: string, mintB: string): WalletAsset | null {
  const eligible = assets.filter((item) => item.eligible);
  const preferred = [USDC_MINT, NATIVE_SOL_MINT, mintA, mintB];
  for (const mint of preferred) {
    const found = eligible.find((item) => item.mint === mint);
    if (found) return found;
  }
  return eligible.find((item) => item.mint === mintA || item.mint === mintB || item.mint === NATIVE_SOL_MINT || item.mint === USDC_MINT) ?? null;
}

export function useOpenPositionController(pair: OpenPositionPair | null) {
  const { address: wallet, connected, connect, signTransaction } = useWalletConnection();
  const [discovery, setDiscovery] = useState<WalletDiscovery | null>(null);
  const [inputMint, setInputMint] = useState<string | null>(null);
  const [inputKind, setInputKind] = useState<"native" | "token">("token");
  const [amount, setAmount] = useState("");
  const [rangePreset, setRangePreset] = useState<OpenRangePreset>("standard");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [quote, setQuote] = useState<OpenPositionQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [submitStage, setSubmitStage] = useState<OpenSubmitStage>(null);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [positionMint, setPositionMint] = useState("");
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const quoteRequestRef = useRef(0);
  const submittingRef = useRef(false);

  const inputAssets = useMemo(() => {
    if (!discovery || !pair) return [];
    const allowed = new Set([NATIVE_SOL_MINT, USDC_MINT, pair.mintA, pair.mintB]);
    return discovery.assets.filter((item) => allowed.has(item.mint));
  }, [discovery, pair]);

  const selectedAsset = inputAssets.find((item) => item.mint === inputMint && item.kind === inputKind) ?? null;
  const fresh = quote ? quoteIsFresh(quote.expiresAt, now) : false;
  const busy = submitStage === "preparing" || submitStage === "wallet" || submitStage === "broadcasting";
  let parsedAmount: bigint | null = null;
  if (selectedAsset?.eligible && amount) {
    try {
      parsedAmount = parseTokenAmount(amount, selectedAsset.decimals);
    } catch {
      parsedAmount = null;
    }
  }
  const formError = amount && selectedAsset && parsedAmount === null
    ? "Enter a valid amount"
    : rangePreset === "custom" && (!minPrice || !maxPrice)
      ? "Enter a custom min and max price (B per 1 A)"
      : "";

  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!wallet) {
      const timer = window.setTimeout(() => {
        setDiscovery(null);
        setInputMint(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/wallet?wallet=${encodeURIComponent(wallet)}`, {
            cache: "no-store", signal: aborter.signal,
          });
          const data = await response.json() as WalletDiscovery | ApiError;
          if (!response.ok) throw new Error((data as ApiError).error);
          if (walletRef.current !== wallet) return;
          const found = data as WalletDiscovery;
          setDiscovery(found);
          const pick = pair ? pickInput(found.assets, pair.mintA, pair.mintB) : null;
          if (pick) {
            setInputMint(pick.mint);
            setInputKind(pick.kind);
          }
        } catch (caught) {
          if (!aborter.signal.aborted) {
            setDiscovery(null);
            setError(caught instanceof Error ? caught.message : "Wallet scan failed");
          }
        }
      })();
    }, 0);
    return () => {
      aborter.abort();
      window.clearTimeout(timer);
    };
  }, [wallet, pair]);

  useEffect(() => {
    if (!pair || !wallet || !inputMint || !selectedAsset?.eligible || busy || submitStage === "confirmed") return;
    if (parsedAmount === null || formError) return;
    const raw = parsedAmount;
    const requestId = ++quoteRequestRef.current;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      const load = async () => {
        setQuoteLoading(true);
        setQuoteError("");
        setQuote(null);
        try {
          const response = await fetch("/api/open-quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wallet, poolId: pair.poolAddress, inputMint, inputKind, amount,
              rangePreset, minPrice, maxPrice,
            }),
            cache: "no-store",
            signal: aborter.signal,
          });
          const data = await response.json() as OpenPositionQuote | ApiError;
          if (requestId !== quoteRequestRef.current) return;
          if (!response.ok) throw new Error((data as ApiError).error);
          const current = data as OpenPositionQuote;
          if (current.requested !== raw.toString()) throw new Error("Quote and current input mismatch, please re-enter amount");
          setQuote(current);
          setNow(Date.now());
        } catch (caught) {
          if (requestId === quoteRequestRef.current && !aborter.signal.aborted) {
            setQuoteError(caught instanceof Error ? caught.message : "Quote failed");
          }
        } finally {
          if (requestId === quoteRequestRef.current) setQuoteLoading(false);
        }
      };
      void load();
    }, 450);
    return () => {
      aborter.abort();
      window.clearTimeout(timer);
    };
  }, [amount, busy, formError, inputKind, inputMint, maxPrice, minPrice, pair, parsedAmount, rangePreset, selectedAsset, submitStage, wallet]);

  const changeAmount = (value: string) => {
    quoteRequestRef.current += 1;
    setAmount(value);
    setQuote(null);
    setError("");
    setQuoteError("");
  };

  const chooseAsset = (kind: "native" | "token", mint: string) => {
    quoteRequestRef.current += 1;
    setInputKind(kind);
    setInputMint(mint);
    setQuote(null);
    setError("");
    setQuoteError("");
  };

  const choosePreset = (preset: OpenRangePreset) => {
    quoteRequestRef.current += 1;
    setRangePreset(preset);
    setQuote(null);
    setError("");
    setQuoteError("");
  };

  const fillMax = () => {
    if (!selectedAsset) return;
    changeAmount(formatAmount(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals));
  };

  const signAndSend = useCallback(async () => {
    if (!pair || !wallet || !inputMint || !quote || !fresh || busy || submittingRef.current || quoteLoading) return;
    submittingRef.current = true;
    setSubmitStage("preparing");
    setError("");
    try {
      const response = await fetch("/api/open-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet, poolId: pair.poolAddress, inputMint, inputKind, amount,
          rangePreset, minPrice, maxPrice,
        }),
        cache: "no-store",
      });
      const data = await response.json() as Prepared | ApiError;
      if (!response.ok) throw new Error((data as ApiError).error);
      const prepared = data as Prepared;
      if (!prepared.unsignedTransaction || !prepared.permit || !prepared.summary ||
        Date.now() >= prepared.summary.expiresAt) {
        throw new Error("Prepared open-position transaction expired or incomplete");
      }
      const bytes = Uint8Array.from(atob(prepared.unsignedTransaction), (character) => character.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) {
        throw new Error("Transaction payer mismatch");
      }
      setSubmitStage("wallet");
      const signedByWallet = await signTransaction(unsigned);
      const originalMessage = unsigned.message.serialize();
      const signedMessage = signedByWallet.message.serialize();
      if (signedMessage.length !== originalMessage.length ||
        signedMessage.some((byte, index) => byte !== originalMessage[index])) {
        throw new Error("Wallet modified transaction content, stopped submission");
      }
      const signed = preserveExtraSignatures(unsigned, signedByWallet);
      const signatureBytes = signed.signatures[0];
      if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) {
        throw new Error("Wallet did not return a valid signature");
      }
      if (!signed.signatures[1] || signed.signatures[1].every((byte) => byte === 0)) {
        throw new Error("Position NFT mint partial signature missing after wallet sign");
      }
      const txSignature = bs58.encode(signatureBytes);
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      setSubmitStage("broadcasting");
      const sent = await fetch("/api/open-broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction,
          permit: prepared.permit,
          wallet,
          summary: prepared.summary,
        }),
        cache: "no-store",
      });
      const broadcast = await sent.json() as { signature?: string; positionMint?: string; error?: string; sent?: boolean };
      if (!sent.ok) {
        const reason = broadcast.error || "Open-position submission failed";
        throw new Error(broadcast.sent === false ? notSentRetryMessage(reason) : reason);
      }
      if (broadcast.signature !== txSignature) throw new Error("RPC returned transaction signature mismatch");
      setSignature(txSignature);
      setPositionMint(broadcast.positionMint || prepared.summary.nftMint);
      setSubmitStage("confirmed");
    } catch (caught) {
      setSubmitStage(null);
      setError(caught instanceof Error ? caught.message : "Open-position transaction failed");
    } finally {
      submittingRef.current = false;
    }
  }, [amount, busy, fresh, inputKind, inputMint, maxPrice, minPrice, pair, quote, quoteLoading, rangePreset, signTransaction, wallet]);

  const walletBlockedReason = !connected
    ? "Connect a wallet to add liquidity"
    : !selectedAsset
      ? "No eligible SOL, USDC, or pool token in this wallet"
      : selectedAsset && !selectedAsset.eligible
        ? (selectedAsset.reason || "Selected asset is not eligible")
        : null;

  const actionDisabled = busy || quoteLoading || !quote || !fresh || !quote.passesFloor || Boolean(walletBlockedReason);

  return {
    wallet, connected, connect, inputAssets, selectedAsset, inputMint, inputKind,
    amount, rangePreset, minPrice, maxPrice, quote, quoteLoading, quoteError: formError || quoteError, error,
    submitStage, signature, positionMint, presets: OPEN_RANGE_PRESETS, fresh, busy,
    actionDisabled, walletBlockedReason, changeAmount, chooseAsset, choosePreset,
    setMinPrice, setMaxPrice, fillMax, signAndSend,
  };
}
