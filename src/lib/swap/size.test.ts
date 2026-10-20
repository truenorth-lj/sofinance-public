import { expect, it } from "vitest";
import { feeSizeFixtures, selectedHoodSizeFixtures, selectedHoodSizeSavings } from "./size-fixtures";
it("measures complete offline packets with Beam tips and snapshots fee overhead", () => {
  const sizes = feeSizeFixtures();
  // eslint-disable-next-line no-console -- requested offline size report
  console.table(sizes);
  expect(sizes).toMatchSnapshot();
  expect(sizes.filter(row => row.fits).every(row => row.serialized)).toBe(true);
  expect(sizes.find(row => row.flow === "compound + USDC fee route / ATA exists")!.fits).toBe(false);
});

it("catches SPCX→HOOD production fee+tip oversize and measures ALT / skip-tip savings", () => {
  const sizes = selectedHoodSizeFixtures();
  // eslint-disable-next-line no-console -- requested offline size report
  console.table(sizes);
  expect(sizes).toMatchSnapshot();
  const savings = selectedHoodSizeSavings(sizes);
  expect(savings.hoodPreview).toBeGreaterThanOrEqual(1068);
  expect(savings.hoodProductionNaive).toBeGreaterThan(savings.limit);
  expect(savings.hoodSkipTip).toBeLessThanOrEqual(savings.limit);
  expect(savings.hoodCompactAlt).toBeLessThanOrEqual(savings.limit);
  expect(savings.hoodProductionNaive - savings.hoodSkipTip).toBeGreaterThanOrEqual(45);
  expect(savings.hoodProductionNaive - savings.hoodCompactAlt).toBeGreaterThanOrEqual(28);
  expect(savings.hoodHighProductionNaive).toBeGreaterThan(savings.limit);
  expect(savings.hoodHighSkipTip).toBeLessThan(savings.hoodHighProductionNaive);
  expect(savings.hoodHighCompactAlt).toBeLessThan(savings.hoodHighProductionNaive);
  expect(sizes.filter((row) => row.fits).every((row) => row.serialized)).toBe(true);
});
