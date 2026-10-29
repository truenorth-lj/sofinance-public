import { expect, it } from "vitest";
import { feeSizeFixtures } from "./size-fixtures";
it("measures complete offline packets and snapshots fee overhead", () => {
  const sizes = feeSizeFixtures();
  // eslint-disable-next-line no-console -- requested offline size report
  console.table(sizes);
  expect(sizes).toMatchSnapshot();
  expect(sizes.filter(row => row.fits).every(row => row.serialized)).toBe(true);
  expect(sizes.find(row => row.flow === "compound input-token fee / ATA exists")!.fits).toBe(true);
  expect(sizes.find(row => row.flow === "exit USDC platform fee / ATA exists")!.fits).toBe(true);
});
