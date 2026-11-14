import { expect, type Page } from "@playwright/test";

/** Every tool picks its position from the All positions rows; the selected one opens its detail with the tool tabs. */
export async function selectPosition(page: Page, key: string) {
  const panel = page.getByRole("region", { name: "All positions", exact: true });
  const row = panel.getByTestId("position-fallback-select").and(page.locator(`[data-position-key="${key}"]`));
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("selected-position-detail")).toHaveAttribute("data-selected-key", key);
}

/** Compound fees has no dropdown of its own any more: it uses the same All positions rows. */
export const selectCompoundPosition = selectPosition;
