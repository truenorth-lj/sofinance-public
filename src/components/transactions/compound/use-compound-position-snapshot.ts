import { useCallback, useRef, useState } from "react";
import type { CompoundPositionState } from "@sofinance/engine/compound-types";
import { isRpcUnavailable, post } from "./compound-client";

type Options = {
  wallet?: string;
  positionMint?: string;
  isCurrent: (identity: string) => boolean;
  onReadSuccess: (identity: string) => void;
  onReadError: (identity: string, message: string) => void;
};

/**
 * Yield reads are safe to repeat. A provider rate-limit window is about a second, so wait it out a
 * couple of times before showing "Solana RPC is temporarily unavailable" (one burst of page-load
 * reads should not surface as an error).
 */
export const COMPOUND_STATE_RPC_RETRY_DELAYS_MS = [1_500, 3_000] as const;

/** Explicit reads only. The facade owns initial/reset timing and supplies stable policy callbacks. */
export function useCompoundPositionSnapshot({ wallet, positionMint, isCurrent, onReadSuccess, onReadError }: Options) {
  const [state, setState] = useState<CompoundPositionState | null>(null);
  const [loading, setLoading] = useState(false);
  const stateRequest = useRef(0);
  const refresh = useCallback(async () => {
    const requestedWallet = wallet;
    const requestedMint = positionMint;
    const requestId = ++stateRequest.current;
    if (!requestedWallet || !requestedMint) { setState(null); setLoading(false); return; }
    const requestedIdentity = `${requestedWallet}:${requestedMint}`;
    setLoading(true);
    try {
      let next: CompoundPositionState;
      for (let attempt = 0; ; attempt += 1) {
        try {
          next = await post<CompoundPositionState>("/api/compound-state", { wallet: requestedWallet, positionMint: requestedMint });
          break;
        } catch (caught) {
          const delay = COMPOUND_STATE_RPC_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isRpcUnavailable(caught)) throw caught;
          await new Promise<void>((resolve) => { window.setTimeout(resolve, delay); });
          if (!isCurrent(requestedIdentity) || requestId !== stateRequest.current) return;
        }
      }
      if (!isCurrent(requestedIdentity) || requestId !== stateRequest.current) return;
      if (next.wallet !== requestedWallet || next.positionMint !== requestedMint) throw new Error("Yield reading does not match selected position");
      setState(next);
      onReadSuccess(requestedIdentity);
    } catch (caught) {
      if (isCurrent(requestedIdentity) && requestId === stateRequest.current) {
        // A failed read preserves the last snapshot. Error priority belongs to the facade.
        onReadError(requestedIdentity, caught instanceof Error ? caught.message : "Yield reading failed");
      }
    } finally {
      if (isCurrent(requestedIdentity) && requestId === stateRequest.current) setLoading(false);
    }
  }, [wallet, positionMint, isCurrent, onReadSuccess, onReadError]);
  // A position read that arrived some other way (the confirmation of a finalized compound) replaces any read still in flight,
  // so the tab does not read the same position twice.
  const adopt = useCallback((next: CompoundPositionState) => {
    stateRequest.current++;
    setState(next); setLoading(false);
    onReadSuccess(`${next.wallet}:${next.positionMint}`);
  }, [onReadSuccess]);
  const invalidate = useCallback(() => { stateRequest.current++; }, []);
  const clear = useCallback(() => { setState(null); }, []);
  return { state, loading, refresh, adopt, invalidate, clear };
}
