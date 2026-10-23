import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMS_RESTRICTED_REGIONS } from "@/lib/terms-content";
import { LEGAL_ROUTES } from "@/lib/public-urls";

const page = readFileSync(resolve("src/app/terms/page.tsx"), "utf8");

describe("/terms page", () => {
  it("lists the restricted regions enforced by the app and prohibits circumvention", () => {
    expect(TERMS_RESTRICTED_REGIONS.join(" | ")).toBe([
      "Taiwan",
      "the United States and its territories (Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the Northern Mariana Islands and the U.S. Minor Outlying Islands)",
      "Cuba", "Iran", "North Korea", "Syria",
      "the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine",
    ].join(" | "));
    expect(page).toContain("VPN, proxy or any other means to circumvent");
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
