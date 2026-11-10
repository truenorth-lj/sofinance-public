import { expect, type Page } from "@playwright/test";

/** Lightweight All positions rows used by non-Performance tools. */
export async function selectPosition(page: Page, key: string) {
  const panel = page.getByRole("region", { name: "All positions", exact: true });
  const row = panel.getByTestId("position-fallback-select").and(page.locator(`[data-position-key="${key}"]`));
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("selected-position-detail")).toContainText(`Selected position · ${key}`);
}
