"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { LoaderCircle, CircleAlert, CheckCircle2 } from "lucide-react";
import { InkShell, InkCard, InkNav } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import type { PendingSignPayload } from "@/lib/pending-sign-token";

type Status = "loading" | "expired" | "wallet-mismatch" | "ready" | "signing" | "submitting" | "success" | "error";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

export default function SignPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { address: wallet, connected, connect, disconnect, signTransaction } = useWalletConnection();
  
  const [payload, setPayload] = useState<PendingSignPayload | null>(null);
  const [loadStatus, setLoadStatus] = useState<"loading" | "expired" | "error" | "loaded">("loading");
  const [signStatus, setSignStatus] = useState<"idle" | "signing" | "submitting" | "success">("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");

  const signToken = params.token;
  
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
    
    setSignStatus("signing");
    setError("");
    
    try {
      const bytes = Uint8Array.from(atob(payload.unsignedTransaction), (c) => c.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) {
        throw new Error("Transaction payer mismatch");
      }
      
      const signed = await signTransaction(unsigned);
      
      const originalMessage = unsigned.message.serialize();
      const signedMessage = signed.message.serialize();
      if (
        signedMessage.length !== originalMessage.length ||
        signedMessage.some((byte, index) => byte !== originalMessage[index])
      ) {
        throw new Error("Wallet modified transaction content");
      }
      
      const signatureBytes = signed.signatures[0];
      if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) {
        throw new Error("Invalid signature from wallet");
      }
      
      const txSignature = bs58.encode(signatureBytes);
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      
      setSignStatus("submitting");
      
      const submitPath = payload.kind === "add-liquidity" 
        ? "/api/selected-broadcast" 
        : "/api/compound-broadcast";
      
      const submitBody = payload.kind === "add-liquidity"
        ? { signedTransaction, ...payload.submitArgs }
        : { 
            signedTransaction, 
            permit: payload.submitArgs.permit,
            wallet: payload.submitArgs.wallet,
            summary: payload.submitArgs.summary,
          };
      
      const response = await fetch(submitPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitBody),
        cache: "no-store",
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        throw new Error(result.error || "Transaction submission failed");
      }
      
      if (result.signature !== txSignature) {
        throw new Error("RPC returned signature mismatch");
      }
      
      setSignature(txSignature);
      setSignStatus("success");
      
      setTimeout(() => {
        router.push("/app");
      }, 5000);
    } catch (caught) {
      setSignStatus("idle");
      setLoadStatus("error");
      setError(caught instanceof Error ? caught.message : "Signing failed");
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

  const kindLabel = payload?.kind === "add-liquidity" ? "Add Liquidity" : "Compound";
  const showSign = status === "ready" && connected && wallet === payload?.wallet;
  const showConnect = status === "ready" && !connected;
  const isBusy = status === "signing" || status === "submitting";

  return (
    <InkShell maxWidth="3xl">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />
      
      <div className="mb-6 mt-8 sm:mt-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Sign transaction
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          Review and sign the prepared transaction
        </p>
      </div>

      <InkCard>
        <div className="space-y-6">
          <div className="flex items-start gap-3">
            {status === "loading" && <LoaderCircle className="mt-1 h-5 w-5 animate-spin text-neutral-400" />}
            {status === "expired" && <CircleAlert className="mt-1 h-5 w-5 text-amber-500" />}
            {status === "error" && <CircleAlert className="mt-1 h-5 w-5 text-red-500" />}
            {status === "success" && <CheckCircle2 className="mt-1 h-5 w-5 text-green-500" />}
            {["wallet-mismatch", "ready", "signing", "submitting"].includes(status) && (
              <div className="mt-1 h-5 w-5 rounded-full border-2 border-neutral-600" />
            )}
            
            <div className="flex-1">
              <p className="text-sm leading-6 text-neutral-300">{statusMessage}</p>
            </div>
          </div>

          {payload && status !== "loading" && (
            <div className="space-y-4 rounded-xl border border-neutral-800/60 bg-neutral-900/50 p-4">
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-neutral-500">Transaction type</span>
                <span className="font-medium text-neutral-100">{kindLabel}</span>
              </div>
              
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-neutral-500">Wallet</span>
                <span className="font-mono text-xs text-neutral-300">{short(payload.wallet)}</span>
              </div>
              
              {payload.kind === "add-liquidity" && (
                <>
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-neutral-500">Position</span>
                    <span className="font-mono text-xs text-neutral-300">
                      {short((payload.submitArgs.selection as { positionMint: string }).positionMint)}
                    </span>
                  </div>
                  
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="text-neutral-500">Amount</span>
                    <span className="font-medium text-neutral-100">
                      {(payload.submitArgs.requested as string) || "—"}
                    </span>
                  </div>
                </>
              )}
              
              {payload.kind === "compound" && (
                <div className="flex items-start justify-between gap-4 text-sm">
                  <span className="text-neutral-500">Position</span>
                  <span className="font-mono text-xs text-neutral-300">
                    {short((payload.submitArgs.summary as { positionMint: string }).positionMint)}
                  </span>
                </div>
              )}
              
              <div className="flex items-start justify-between gap-4 text-sm">
                <span className="text-neutral-500">Expires</span>
                <span className="text-xs text-neutral-400">
                  {new Date(payload.expiresAt).toLocaleString()}
                </span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row">
            {showConnect && (
              <button
                onClick={connect}
                className="flex-1 rounded-xl border border-neutral-700 bg-transparent px-4 py-3 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
              >
                Connect wallet
              </button>
            )}
            
            {showSign && (
              <button
                onClick={handleSign}
                disabled={isBusy}
                className="flex-1 rounded-xl border border-neutral-700 bg-transparent px-4 py-3 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50 disabled:cursor-not-allowed disabled:opacity-40"
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
                className="flex-1 rounded-xl border border-neutral-700 bg-transparent px-4 py-3 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
              >
                Disconnect wallet
              </button>
            )}
          </div>

          {signature && (
            <div className="rounded-xl border border-green-900/50 bg-green-950/20 p-4">
              <p className="text-sm font-medium text-green-400">Transaction submitted</p>
              <p className="mt-2 text-xs text-green-300">
                <a
                  href={`https://solscan.io/tx/${signature}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  View on Solscan: {short(signature)}
                </a>
              </p>
            </div>
          )}
        </div>
      </InkCard>
      
      <div className="mt-6 text-center">
        <button
          onClick={() => router.push("/app")}
          className="text-sm text-neutral-400 underline hover:text-neutral-300"
        >
          Return to app
        </button>
      </div>
    </InkShell>
  );
}
