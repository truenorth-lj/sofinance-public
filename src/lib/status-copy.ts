/** Look up copy for a stage. Missing keys fall through to `fallback`. */
export function statusCopy<S extends string>(
  stage: S | null | undefined,
  table: Partial<Record<S, string>>,
  fallback?: string,
): string | undefined {
  if (stage && table[stage] !== undefined) return table[stage];
  return fallback;
}

const OPEN_SWAP_STATUS = {
  "swap-preparing": "Preparing SOL swap…",
  "swap-wallet": "Sign the SOL swap in your wallet…",
  "swap-checking": "Your wallet returned an error. Checking Solana in case the swap went through…",
  "swap-broadcasting": "Sending SOL swap…",
  "swap-pending": "Waiting for the swap to confirm…",
} as const;

const OPEN_STEP_STATUS = {
  preparing: "Preparing open position…",
  wallet: "Sign the open position in your wallet…",
  checking: "Your wallet returned an error. Checking Solana in case it went through…",
  broadcasting: "Sending open position…",
} as const;

const OPEN_SUBMIT_STATUS = {
  preparing: "Preparing latest transaction…",
  wallet: "Confirm in your wallet…",
  checking: "Your wallet returned an error. Checking Solana in case it went through; please wait…",
  broadcasting: "Sending transaction…",
  pending: "Waiting for on-chain confirmation…",
  failed: "A safety check stopped it on-chain, so nothing changed except the network fee.",
  expired: "It expired before Solana included it, so nothing changed.",
  confirmed: "Position opened",
} as const;

const OPEN_STEP_STAGES = new Set<string>(["preparing", "wallet", "checking", "broadcasting"]);

/** Status line for the open-position modal. Strings and precedence are unchanged. */
export function openPositionStatusCopy(input: {
  submitStage: string | null | undefined;
  openStep: number | string | null | undefined;
  quoteLoading: boolean;
  hasQuote: boolean;
  actionBlockedReason: string | null | undefined;
}): string {
  const stepPrefix = input.openStep ? `Step ${input.openStep}/2 · ` : "";
  const swapStatus = statusCopy(input.submitStage, OPEN_SWAP_STATUS);
  if (swapStatus) return `${stepPrefix}${swapStatus}`;
  if (input.openStep && input.submitStage && OPEN_STEP_STAGES.has(input.submitStage)) {
    return `${stepPrefix}${statusCopy(input.submitStage, OPEN_STEP_STATUS)}`;
  }
  return (
    statusCopy(input.submitStage, OPEN_SUBMIT_STATUS)
    ?? (input.quoteLoading && !input.hasQuote ? "Fetching quote…" : undefined)
    ?? input.actionBlockedReason
  ) || "Ready to sign";
}


/** Button label for the compound panel (cleanup vs compound, same strings as before). */
export function compoundActionLabel(input: {
  cleanupRunning: boolean;
  stage: string | null | undefined;
  checkingCopy: string;
}): string {
  if (input.cleanupRunning) {
    return statusCopy(input.stage, {
      preparing: "Preparing cleanup…",
      wallet: "Approve cleanup in wallet…",
      checking: input.checkingCopy,
      broadcasting: "Sending cleanup…",
    }, "Verifying cleanup…")!;
  }
  return statusCopy(input.stage, {
    preparing: "Verifying harvested fees and simulating transaction…",
    wallet: "Confirming in wallet…",
    checking: input.checkingCopy,
    broadcasting: "Sending and verifying…",
  }, "One-click compound")!;
}
