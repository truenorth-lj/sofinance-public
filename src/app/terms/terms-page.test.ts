import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMS_JURISDICTION_EN } from "@/lib/terms-content";
import { LEGAL_ROUTES } from "@/lib/public-urls";

const page = readFileSync(resolve("src/app/terms/page.tsx"), "utf8");

describe("/terms page", () => {
  it("asks users to confirm their own local law, with no region list or IP blocking (Section 3)", () => {
    expect(TERMS_JURISDICTION_EN).toBe("Users are responsible for confirming that use of the Service is permitted under the laws of their jurisdiction. The Service may not be used from sanctioned jurisdictions.");
    expect(page).toContain("{TERMS_JURISDICTION_EN}");
    expect(page).toContain("3. Eligibility and applicable law");
    expect(page).not.toMatch(/restricted region|IP-based|VPN|Taiwan|TERMS_RESTRICTED_REGIONS/);
    expect(readFileSync(resolve("src/lib/terms-content.ts"), "utf8")).not.toContain("restricted-regions.ts");
  });

  it("covers the required positioning, risks, fees and legal provisions", () => {
    for (const phrase of ["self-custodial software interface", "do not take custody", "never receives, holds or controls your funds",
      "do not issue any token", "issued by third parties", "investment, financial, legal, tax", "Impermanent loss",
      "earns no fees", "Smart-contract", "Tokenized-stock risk", "not guaranteed", "10 basis points (0.10%)",
      "opening a position", "withdrawing or converting", "compounding", "Solana network fees", "Raydium CLMM position NFTs",
      "directly on Raydium", "as is", "Limitation of liability", "Changes to these Terms"]) {
      expect(page, phrase).toContain(phrase);
    }
  });

  it("does not claim to be open source and shows no draft banner", () => {
    expect(page).not.toMatch(/open[- ]source/i);
    expect(page).not.toMatch(/draft|lawyer|pending review/i);
  });

  it("is linked from the landing footer and the docs footer", () => {
    expect(LEGAL_ROUTES.terms).toBe("/terms");
    expect(readFileSync(resolve("src/components/landing-page.tsx"), "utf8")).toContain("LEGAL_ROUTES.terms");
    expect(readFileSync(resolve("src/components/docs/docs-shell.tsx"), "utf8")).toContain("LEGAL_ROUTES.terms");
  });
});
