import { act } from "react";

/**
 * Tests only: drive the Portfolio rows (LJ 11/14): every operation is a row button that opens its popup, and the row
 * itself opens the position's Performance detail.
 */
type Tool = "compound" | "deposit" | "withdraw" | "activity";

const rowOf = (scope: ParentNode, key?: string) => key
  ? scope.querySelector(`[data-testid="position-fallback-select"][data-position-key="${key}"]`)?.closest("li") ?? null
  : scope.querySelector('[data-testid="position-row"]');

export function rowAction(scope: ParentNode, tool: Tool, key?: string): HTMLButtonElement | null {
  return rowOf(scope, key)?.querySelector<HTMLButtonElement>(`[data-testid="position-row-action"][data-tool="${tool}"]`) ?? null;
}

/** Click a row's button (Add / Withdraw / Compound / Activity), which opens its popup. */
export async function openRowTool(scope: ParentNode, tool: Tool, key?: string) {
  const button = rowAction(scope, tool, key);
  if (!button) throw new Error(`no ${tool} button${key ? ` on ${key}` : ""}`);
  await act(async () => button.click());
}

/** Click the row itself (its title area), which opens the position's Performance detail. */
export async function openRowDetail(scope: ParentNode, key?: string) {
  const button = (rowOf(scope, key)?.querySelector<HTMLButtonElement>('[data-testid="position-fallback-select"]')) ?? null;
  if (!button) throw new Error(`no row${key ? ` ${key}` : ""}`);
  await act(async () => button.click());
}

/** The open Compound popup's Confirm button (null when it is not on its confirm step). */
export function compoundConfirmButton(scope: ParentNode): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>('dialog[data-testid="compound-popup"][data-open="true"] [data-testid="compound-confirm-button"]');
}

/** A popup by its test id, only while open. */
export function openPopup(scope: ParentNode, testId: string): HTMLDialogElement | null {
  return scope.querySelector<HTMLDialogElement>(`dialog[data-testid="${testId}"][data-open="true"]`);
}
