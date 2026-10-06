import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AtomicStatus } from "@/lib/attempt-status";
import type { SelectedAttempt } from "@/lib/selected-attempt";
import { TransactionStatusDialog } from "./transaction-status-dialog";

const signature = "1".repeat(88);
const attempt = {
  version: 2, wallet: "wallet", selection: { positionMint: "position-mint", inputMint: "input-mint", inputKind: "token" },
  poolId: "pool", positionAccount: "position", signature, createdAt: 1,
  requested: "100", floorBps: 9_700, startingBalances: { input: "100", a: "0", b: "0" },
  startingLiquidity: "1", expectedLiquidity: "2", blockhash: "blockhash", lastValidBlockHeight: 3,
} satisfies SelectedAttempt;

function render(status: AtomicStatus, error = "") {
  return renderToStaticMarkup(createElement(TransactionStatusDialog, {
    attempt, status, error, open: true, onOpenChange: () => undefined, onRetry: () => undefined,
  }));
}

describe("transaction status dialog", () => {
  it.each([
    ["pending", "Transaction confirming"], ["success", "Position increased successfully"], ["failed", "On-chain transaction failed"],
    ["expired", "Transaction not on-chain and expired"], ["manual-review", "Transaction result requires manual verification"],
  ] as const)("shows the %s state and the signed transaction hash", (status, title) => {
    const markup = render(status);
    expect(markup).toContain(title);
    expect(markup).toContain(`https://solscan.io/tx/${signature}`);
    expect(markup).toContain(signature);
  });

  it("keeps an uncertain broadcast result pending and offers a fresh lookup", () => {
    const markup = render("pending", "RPC temporarily unavailable");
    expect(markup).toContain("Do not resubmit");
    expect(markup).toContain("RPC temporarily unavailable");
    expect(markup).toContain("Requery on-chain status");
    expect(markup).not.toContain("Position increased successfully");
  });
});
