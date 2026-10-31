"use client";
import "@/lib/engine-host";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { VersionedTransaction } from "@solana/web3.js";
import { LoaderCircle, CircleAlert, CheckCircle2 } from "lucide-react";
import { InkHero, InkShell, InkCard, InkNav } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { notSentRetryMessage } from "@/lib/public-error";
import { addMintSignature, preserveExtraSignatures } from "@/lib/open-signatures";
import { plainTxError, sendAndTrack, TxNotSentError, TxRunError } from "@/lib/tx-pipeline";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
import type { PendingSignPayload } from "@/lib/pending-sign-token";
import { openAttemptFromSummary, type OpenAttempt } from "@/lib/open-attempt";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import { useOpenAttempt } from "@/components/use-open-attempt";
import { captureGrowthEvent, captureGrowthEventOnce } from "@/lib/analytics/client";
import { openFailureProperties, openOutcomeFailureProperties } from "@/lib/analytics/errors";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";

type Status = "loading" | "expired" | "wallet-mismatch" | "ready" | "signing" | "submitting" | "success" | "error";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

export default function SignPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { address: wallet, connected, connect, disconnect, signTransaction, signAndSendTransaction } = useWalletConnection();
  
  const [payload, setPayload] = useState<PendingSignPayload | null>(null);
  const open = useOpenAttempt(payload?.kind === "open-position" ? wallet : undefined);

  useEffect(() => {
    const attempt = open.attempt;
    if (payload?.kind !== "open-position" || !attempt) return;
    const summary = payload.submitArgs.summary as OpenPositionSummary;
    const properties = openEventProperties({
      poolAddress: summary.poolId,
      symbolA: summary.quote.symbolA ?? "",
      symbolB: summary.quote.symbolB ?? "",
    }, { wallet: summary.wallet, inputKind: summary.quote.inputKind });
    if (open.status === "confirmed") {
      captureGrowthEventOnce(`open-ok:${attempt.signature}`, GROWTH_EVENTS.openSuccess, properties);
    } else if (open.status === "failed" || open.status === "expired") {
      captureGrowthEventOnce(`open-fail:${attempt.signature}`, GROWTH_EVENTS.openFailed, {
        ...properties,
        ...openOutcomeFailureProperties(open.status),
      });
    }
  }, [open.attempt, open.status, payload]);
  const [loadStatus, setLoadStatus] = useState<"loading" | "expired" | "error" | "loaded">("loading");
  const [signStatus, setSignStatus] = useState<"idle" | "signing" | "submitting" | "success">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  const verificationSignature = payload?.kind === "open-position" ? open.attempt?.signature || signature : signature;

  const signToken = params.token;
  const identity = `${wallet ?? ""}:${signToken}`;
  const identityRef = useRef(identity);
  useLayoutEffect(() => { identityRef.current = identity; }, [identity]);
  
  const status: Status = (() => {
    if (loadStatus === "loading") return "loading";
    if (loadStatus === "expired") return "expired";
    if (loadStatus === "error") return "error";
    if (signStatus === "signing") return "signing";
    if (signStatus === "submitting") return "submitting";
    if (signStatus === "success") return "success";
    
    if (payload && wallet && wallet !== payload.wallet) return "wallet-mismatch";
    return "ready";
  })();

  useEffect(() => {
    if (!signToken) return;
    
    const load = async () => {
      try {
        const response = await fetch("/api/verify-sign-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: signToken }),
          cache: "no-store",
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          setLoadStatus("expired");
          setError(data.error || "Sign token invalid, expired, or malformed");
          return;
        }
        
        setPayload(data as PendingSignPayload);
        setLoadStatus("loaded");
      } catch (caught) {
        setLoadStatus("error");
        setError(caught instanceof Error ? caught.message : "Failed to verify sign token");
      }
    };
    
    void load();
  }, [signToken]);

  const handleSign = async () => {
    if (!payload || !wallet || wallet !== payload.wallet) return;
    if (payload.kind === "open-position" && (!open.loaded || open.pending)) return;
    let openAttempt: OpenAttempt | null = null;
    let mint: EphemeralMint | undefined;
    
    setSignStatus("signing");
    setError("");
    const openProperties = payload.kind === "open-position"
      ? openEventProperties({
        poolAddress: (payload.submitArgs.summary as OpenPositionSummary).poolId,
        symbolA: (payload.submitArgs.summary as OpenPositionSummary).quote.symbolA ?? "",
        symbolB: (payload.submitArgs.summary as OpenPositionSummary).quote.symbolB ?? "",
      }, { wallet, inputKind: (payload.submitArgs.summary as OpenPositionSummary).quote.inputKind })
      : {};
    if (payload.kind === "open-position") captureGrowthEvent(GROWTH_EVENTS.openStarted, openProperties);
    
    try {
      let prepared = {
        unsignedTransaction: payload.unsignedTransaction,
        permit: payload.submitArgs.permit,
        summary: payload.submitArgs.summary,
      };
      if (payload.kind === "open-position" && payload.openRequest) {
        // MCP open without nftMint: the mint is created here, the server re-prepares with
        // its public key, the wallet signs first and the mint signs the returned tx.
        mint = createEphemeralMint();
        const response = await fetch("/api/sign-open-prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: signToken, nftMint: mint.publicKey.toBase58() }),
          cache: "no-store",
        });
        const data = await response.json() as { unsignedTransaction?: string; permit?: string; summary?: OpenPositionSummary; error?: string };
        if (!response.ok) throw new Error(notSentRetryMessage(data.error || "Open-position preparation failed"));
        if (identityRef.current !== identity || !data.unsignedTransaction || !data.permit || !data.summary ||
          data.summary.wallet !== wallet || data.summary.nftMint !== mint.publicKey.toBase58()) {
          throw new TxNotSentError("Prepared open-position transaction is incomplete. Nothing was sent.");
        }
        prepared = { unsignedTransaction: data.unsignedTransaction, permit: data.permit, summary: data.summary };
      }
      const bytes = Uint8Array.from(atob(prepared.unsignedTransaction), (c) => c.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) {
        throw new Error("Transaction payer mismatch");
      }
      
      // Shared pipeline send stage: the wallet sends; a new position mint co-signs after the wallet.
      const summaryBlockHeight = (prepared.summary as { lastValidBlockHeight?: unknown } | undefined)?.lastValidBlockHeight;
      const lastValidBlockHeight = Number(payload.submitArgs.lastValidBlockHeight ?? summaryBlockHeight);
      if (payload.kind === "open-position") {
        const summary = prepared.summary as OpenPositionSummary;
        if (identityRef.current !== identity) throw new TxNotSentError("Wallet or signing authorization changed. Nothing was sent.");
        if (summary.wallet !== wallet || summary.blockhash !== unsigned.message.recentBlockhash ||
          unsigned.message.staticAccountKeys[1]?.toBase58() !== summary.nftMint) throw new TxNotSentError("Open-position authorization mismatch. Nothing was sent.");
      }
      setSignStatus("submitting");
      const flow = payload.kind === "add-liquidity" ? "add" : payload.kind === "withdraw" ? "withdraw"
        : payload.kind === "open-position" ? "open" : "compound";
      const result = await sendAndTrack({
        flow, wallet: { address: wallet, signTransaction, signAndSendTransaction },
        successTitle: flow === "add" ? "Liquidity added" : flow === "withdraw" ? "Withdrawal confirmed"
          : flow === "open" ? "Position opened" : "Compound confirmed",
        storage: window.localStorage,
        prepared: {
          transaction: unsigned, lastValidBlockHeight: Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight > 0 ? lastValidBlockHeight : Number.MAX_SAFE_INTEGER,
          positionMint: payload.kind === "open-position" ? (prepared.summary as OpenPositionSummary).nftMint : undefined,
          cosign: payload.kind === "open-position"
            ? (walletSigned) => mint ? addMintSignature(walletSigned, mint) : preserveExtraSignatures(unsigned, walletSigned)
            : undefined,
          dispose: () => mint?.dispose(),
        },
      });
      const txSignature = result.signature;
      if (payload.kind === "open-position") {
        openAttempt = openAttemptFromSummary(txSignature, prepared.summary as OpenPositionSummary);
        open.track(openAttempt);
      }
      setSignature(txSignature);
      setSignStatus("success");
      
      setTimeout(() => {
        router.push("/app");
      }, 5000);
    } catch (caught) {
      mint?.dispose();
      if (payload.kind === "open-position" && !openAttempt && !(caught instanceof TxRunError && caught.kind === "rejected")) {
        captureGrowthEvent(GROWTH_EVENTS.openFailed, {
          ...openProperties,
          ...openFailureProperties(caught),
        });
      }
      setSignStatus("idle");
      setLoadStatus("error");
      setError(caught instanceof TxRunError ? caught.message : plainTxError(caught));
    }
  };

  const statusMessage = (() => {
    switch (status) {
      case "loading":
        return "Verifying sign token...";
      case "expired":
        return "This sign token has expired or is invalid. Sign tokens expire after 60-120 seconds.";
      case "wallet-mismatch":
        return `Wrong wallet connected. Please connect wallet ${payload ? short(payload.wallet) : ""}.`;
      case "ready":
        return connected 
          ? "Review the transaction details below and sign to submit." 
          : "Connect your wallet to continue.";
      case "signing":
        return "Waiting for wallet signature...";
      case "submitting":
        return "Broadcasting transaction to Solana...";
      case "success":
        return "Transaction submitted successfully! Redirecting to the app...";
      case "error":
        return error || "An error occurred";
    }
  })();

  const kindLabel = payload?.kind === "add-liquidity"
    ? "Add Liquidity"
    : payload?.kind === "withdraw" ? "Withdraw"
    : payload?.kind === "open-position"
      ? "Open position"
      : "Compound";
  const showSign = status === "ready" && connected && wallet === payload?.wallet &&
    (payload?.kind !== "open-position" || open.loaded && !open.pending);
  const showConnect = status === "ready" && !connected;
  const isBusy = status === "signing" || status === "submitting";

  return (
    <InkShell>
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />
      
      <div className="mx-auto max-w-3xl">
      <InkHero label="Sign" title="Sign transaction">
        <p>Review and sign the prepared transaction</p>
      </InkHero>

      <InkCard className="mt-3">
        <div className="space-y-6">
          <div className="flex items-start gap-3">
            {status === "loading" && <LoaderCircle className="mt-1 h-5 w-5 animate-spin text-smoke" />}
            {status === "expired" && <CircleAlert className="mt-1 h-5 w-5 text-lemon" />}
            {status === "error" && <CircleAlert className="mt-1 h-5 w-5 text-coral" />}
            {status === "success" && <CheckCircle2 className="mt-1 h-5 w-5 text-mint" />}
            {["wallet-mismatch", "ready", "signing", "submitting"].includes(status) && (
              <div className="mt-1 h-5 w-5 rounded-full border-2 border-white/40" />
            )}
            
            <div className="flex-1">
              <p className="text-sm leading-6 text-cream/80">{statusMessage}</p>
            </div>
          </div>

          {payload && status !== "loading" && (
            <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-smoke">Transaction type</span>
                <span className="font-medium text-cream">{kindLabel}</span>
              </div>
              
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-smoke">Wallet</span>
                <span className="font-mono text-xs text-cream/80">{short(payload.wallet)}</span>
              </div>
              
              {payload.kind === "add-liquidity" && (
                <>
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-smoke">Position</span>
                    <span className="font-mono text-xs text-cream/80">
                      {short((payload.submitArgs.selection as { positionMint: string }).positionMint)}
                    </span>
                  </div>
                  
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-smoke">Amount</span>
                    <span className="font-medium text-cream">
                      {(payload.submitArgs.requested as string) || "—"}
                    </span>
                  </div>
                </>
              )}
              
              {payload.kind === "compound" && (
                <div className="flex items-start justify-between gap-4 text-sm">
                  <span className="text-smoke">Position</span>
                  <span className="font-mono text-xs text-cream/80">
                    {short((payload.submitArgs.summary as { positionMint: string }).positionMint)}
                  </span>
                </div>
              )}

              {payload.kind === "open-position" && (
                <>
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-smoke">Pool</span>
                    <span className="font-mono text-xs text-cream/80">
                      {short((payload.submitArgs.summary as { poolId: string }).poolId)}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-smoke">New position NFT</span>
                    <span className="font-mono text-xs text-cream/80">
                      {payload.openRequest ? "Created in your browser when you sign" : short((payload.submitArgs.summary as { nftMint: string }).nftMint)}
                    </span>
                  </div>
                </>
              )}
              
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-smoke">Expires</span>
                <span className="text-xs text-smoke">
                  {new Date(payload.expiresAt).toLocaleString()}
                </span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row">
            {showConnect && (
              <button
                onClick={connect}
                className="flex-1 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]"
              >
                Connect wallet
              </button>
            )}
            
            {showSign && (
              <button
                onClick={handleSign}
                disabled={isBusy}
                className="flex-1 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isBusy ? (
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {status === "signing" ? "Signing..." : "Submitting..."}
                  </span>
                ) : (
                  "Sign and submit"
                )}
              </button>
            )}
            
            {status === "wallet-mismatch" && (
              <button
                onClick={disconnect}
                className="flex-1 rounded-full border border-white/25 px-5 py-3 text-sm font-semibold text-cream/85 transition-colors hover:border-white/70"
              >
                Disconnect wallet
              </button>
            )}
          </div>

          {payload?.kind === "open-position" && open.pending && <p role="status" className="text-sm text-smoke">
            Checking the original open-position transaction before opening again.{open.error ? ` ${open.error}` : ""}
          </p>}
          {verificationSignature && (
            <div className="rounded-2xl border border-mint/30 bg-mint/10 p-4">
              <p className="text-sm font-medium text-mint">{payload?.kind === "open-position" ? "Original open-position transaction" : "Transaction submitted"}</p>
              <p className="mt-2 text-xs text-mint">
                <a
                  href={`https://solscan.io/tx/${verificationSignature}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  View on Solscan: {short(verificationSignature)}
                </a>
              </p>
            </div>
          )}
        </div>
      </InkCard>
      
      <div className="mt-6 text-center">
        <button
          onClick={() => router.push("/app")}
          className="text-sm text-smoke underline hover:text-cream/80"
        >
          Return to app
        </button>
      </div>
      </div>
    </InkShell>
  );
}
