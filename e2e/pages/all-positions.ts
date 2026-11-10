import { expect, type Page } from "@playwright/test";

/** Compound fees has no All positions card: its position comes from the dropdown beside the panel title. */
export async function selectCompoundPosition(page: Page, key: string) {
  const select = page.getByRole("region", { name: "Compound fees", exact: true }).getByLabel("Position to compound", { exact: true });
  await select.selectOption(key);
  await expect(select).toHaveValue(key);
}

/** Lightweight All positions rows used by non-Performance tools other than Compound fees. */
export async function selectPosition(page: Page, key: string) {
  const panel = page.getByRole("region", { name: "All positions", exact: true });
  const row = panel.getByTestId("position-fallback-select").and(page.locator(`[data-position-key="${key}"]`));
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("selected-position-detail")).toContainText(`Selected position · ${key}`);
}
