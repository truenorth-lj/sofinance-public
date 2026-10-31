"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OpenAttempt, OpenAttemptStatus } from "@/lib/open-attempt";
import { noticeIdFor, useTxNotices, type TxNotice } from "@/lib/tx-pipeline";

/** The open modal's view of its last sent signature, read from the shared pipeline's notices. */
export function openStatusFromNotice(notice: TxNotice | undefined): OpenAttemptStatus | null {
  if (!notice) return null;
  if (notice.state === "loading") return "pending";
  if (notice.state === "success") return "confirmed";
  if (notice.kind === "expired") return "expired";
  if (notice.kind === "failed") return "failed";
  return "manual-review";
}

/**
 * Signature-based tracking for the open flow. The shared pipeline saves and polls the
 * signature (and clears it once it settles); this hook only remembers which signature this
 * modal sent so it can show its outcome. No per-flow storage, no status endpoint.
 */
export function useOpenAttempt(wallet: string | undefined) {
  const [attempt, setAttempt] = useState<OpenAttempt | null>(null);
  const [settled, setSettled] = useState<OpenAttemptStatus | null>(null);
  const notices = useTxNotices();
  const visible = attempt && attempt.wallet === wallet ? attempt : null;
  const notice = visible ? notices.find((item) => item.id === noticeIdFor(visible.signature)) : undefined;
  const live = openStatusFromNotice(notice);
  const status = live ?? (visible ? settled : null);
  const pending = status === "pending";
  const pendingRef = useRef(pending);
  useLayoutEffect(() => { pendingRef.current = pending; }, [pending]);
  // Keep the settled outcome after its toast is dismissed.
  useEffect(() => {
    if (!live || live === "pending") return;
    const timer = window.setTimeout(() => setSettled(live), 0);
    return () => window.clearTimeout(timer);
  }, [live]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setAttempt(null); setSettled(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);
  const track = useCallback((next: OpenAttempt) => { setSettled("pending"); setAttempt(next); }, []);
  return {
    attempt: visible, status, error: status === "manual-review" ? notice?.detail ?? "" : "",
    pending, loaded: true,
    canSubmit: () => !pendingRef.current,
    track,
    dismissTerminal: () => { if (!pendingRef.current) { setAttempt(null); setSettled(null); } },
    retry: undefined as (() => void) | undefined,
  };
}
