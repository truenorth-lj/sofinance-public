"use client";
import { useEffect, useRef, useState } from "react";
import { DecisionSession } from "@/lib/lp-decision-session";
import type { DecisionRequest, DecisionResponse } from "@/lib/lp-decision";
export function useLpDecisionController() {
  const session = useRef(new DecisionSession());
  const [result, setResult] = useState<DecisionResponse | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { const current = session.current; return () => current.cancel(); }, []);
  function cancel() { session.current.cancel(); setResult(null); setError(null); setBusy(false); }
  async function run(input: Omit<DecisionRequest, "requestId" | "contextVersion">) {
    const attempt = session.current.begin(); if (!attempt) return;
    const requestId = `lp-${attempt.id}`;
    setBusy(true); setResult(null); setError(null);
    try {
      const response = await fetch("/api/lp-decision", { method: "POST", signal: attempt.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId, contextVersion: attempt.id }) });
      const body = await response.json();
      if (!attempt.current()) return;
      if (!response.ok) throw new Error(body.error || "試算失敗");
      if (body.requestId !== requestId || body.contextVersion !== attempt.id) throw new Error("Response context mismatch");
      setResult(body);
    } catch (e) { if (attempt.current()) setError(e instanceof Error ? e.message : "試算失敗"); }
    finally { if (attempt.current()) { attempt.finish(); setBusy(false); } }
  }
  return { result, busy, error, cancel, run };
}
