import { captureGrowthEvent } from "./client";
import { GROWTH_EVENTS } from "./events";
import {
  classifyWalletConnectError,
  redactWalletConnectErrorMessage,
  walletConnectContext,
  type WalletConnectChain,
  type WalletConnectContext,
} from "./wallet-connect";

export type WalletConnectAttemptOutcome = "open" | "started" | "succeeded" | "failed" | "abandoned";

type Attempt = { context: WalletConnectContext; outcome: WalletConnectAttemptOutcome };

let attempt: Attempt | null = null;

export function resetWalletConnectSessionForTests() {
  attempt = null;
}

export function walletConnectAttemptForTests(): Attempt | null {
  return attempt ? { ...attempt, context: { ...attempt.context } } : null;
}

/** A connect picker or sheet was opened. Later close without success/failure becomes abandoned. */
export function openWalletConnectSession(partial: Parameters<typeof walletConnectContext>[0]): WalletConnectContext {
  const context = walletConnectContext(partial);
  attempt = { context, outcome: "open" };
  return context;
}

export function captureWalletConnectStarted(partial: { wallet_name: string; chain: WalletConnectChain } & Partial<WalletConnectContext>): WalletConnectContext {
  const context = walletConnectContext({ ...attempt?.context, ...partial, wallet_name: partial.wallet_name, chain: partial.chain });
  if (!attempt || attempt.outcome === "abandoned" || attempt.outcome === "failed" || attempt.outcome === "succeeded") {
    attempt = { context, outcome: "started" };
  } else {
    attempt = { context, outcome: "started" };
  }
  captureGrowthEvent(GROWTH_EVENTS.walletConnectStarted, context);
  return context;
}

export function captureWalletConnectFailed(error: unknown, partial?: Partial<WalletConnectContext> & { chain?: WalletConnectChain }): void {
  if (attempt?.outcome === "succeeded" || attempt?.outcome === "failed") return;
  const context = walletConnectContext({ chain: partial?.chain ?? attempt?.context.chain ?? "solana", ...attempt?.context, ...partial });
  attempt = { context, outcome: "failed" };
  const properties: Record<string, unknown> = { ...context, error_type: classifyWalletConnectError(error) };
  const error_message = redactWalletConnectErrorMessage(error);
  if (error_message) properties.error_message = error_message;
  captureGrowthEvent(GROWTH_EVENTS.walletConnectFailed, properties);
}

/** Closing the wallet modal/sheet without a connect. No-ops after success or failure (and will not fire twice). */
export function captureWalletConnectAbandoned(): void {
  if (!attempt || attempt.outcome === "succeeded" || attempt.outcome === "failed" || attempt.outcome === "abandoned") return;
  const context = attempt.context;
  attempt = { context, outcome: "abandoned" };
  captureGrowthEvent(GROWTH_EVENTS.walletConnectAbandoned, context);
}

/** Mark the open attempt as succeeded so a later modal close does not fire abandoned. */
export function noteWalletConnectSucceeded(): void {
  if (!attempt) return;
  attempt = { ...attempt, outcome: "succeeded" };
}

export function captureWalletDeeplinkClicked(wallet_name: "Phantom" | "Solflare", partial?: Partial<WalletConnectContext>): WalletConnectContext {
  const context = captureWalletConnectStarted({ wallet_name, chain: "solana", ...partial });
  captureGrowthEvent(GROWTH_EVENTS.walletDeeplinkClicked, { ...context, wallet_name });
  return context;
}
