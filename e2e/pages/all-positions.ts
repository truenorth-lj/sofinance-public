import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Portfolio rows (LJ 11/14): every operation is a row button (Compound, Add, Withdraw / Close, Activity) that opens its
 * popup, a centered modal on desktop and a bottom sheet on a phone. The row itself opens the Performance detail.
 */
export type RowTool = "compound" | "deposit" | "withdraw" | "activity";

export function positionRow(page: Page, key: string): Locator {
  return page.getByTestId("position-row").filter({ has: page.locator(`[data-testid="position-fallback-select"][data-position-key="${key}"]`) });
}

/** An open popup by its test id (compound-popup, deposit-popup, withdraw-popup, activity-popup, performance-popup). */
export const openPopup = (page: Page, testId: string) => page.locator(`dialog[data-testid="${testId}"][data-open="true"]`);

/** Click a row's button (the first row's when `key` is null) and wait for its popup. */
export async function openRowTool(page: Page, key: string | null, tool: RowTool): Promise<Locator> {
  const row = key === null ? page.getByTestId("position-row").first() : positionRow(page, key);
  await row.locator(`[data-testid="position-row-action"][data-tool="${tool}"]`).click();
  const popup = openPopup(page, `${tool}-popup`);
  await expect(popup).toBeVisible();
  return popup;
}

/** Click the row itself (its title button) and wait for the Performance detail. */
export async function openRowDetail(page: Page, key: string): Promise<Locator> {
  await positionRow(page, key).getByTestId("position-fallback-select").click();
  const popup = openPopup(page, "performance-popup");
  await expect(popup).toBeVisible();
  return popup;
}

/** Close whichever popup is open with its X. */
export async function closePopup(page: Page) {
  const open = page.locator('dialog[data-open="true"]');
  await open.locator('button[aria-label="Close"]').first().click();
  await expect(open).toHaveCount(0);
}

/** Selecting a position is opening one of its popups; Add is the one every Solana position has. */
export async function selectPosition(page: Page, key: string) {
  return openRowTool(page, key, "deposit");
}
