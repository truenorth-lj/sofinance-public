import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_ROUTES } from "@/lib/public-urls";
import { metadata } from "./page";

const page = readFileSync(resolve("src/app/privacy/page.tsx"), "utf8");

describe("/privacy draft", () => {
  it("is marked draft and kept out of search, the footer and the sitemap until approved", () => {
    expect(LEGAL_ROUTES.privacy).toBe("/privacy");
    expect(page).toContain("Draft for review. Not yet in effect.");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(readFileSync(resolve("src/components/site-footer.tsx"), "utf8")).not.toContain("LEGAL_ROUTES.privacy");
    expect(readFileSync(resolve("src/app/sitemap.ts"), "utf8")).not.toContain("LEGAL_ROUTES.privacy");
  });

  it("states the data practices the code has today", () => {
    for (const phrase of ["No accounts.", "No keys.", "we do not keep a copy", "keyed by the position NFT, not by wallet",
      "Do Not Track", "linked to its public address", "UTM parameters", "PostHog receives your IP address",
      "session recording, heatmaps and surveys", "SHA-256 hash of the wallet address", "shared anonymous identifier",
      "No person profile is created, and location lookup is turned off", "Default personal data collection is off",
      "Session replay is off", "hosted on Vercel", "never blocked", "in server memory for one minute",
      "RPC providers", "Reown AppKit, with its analytics turned off"]) {
      expect(page, phrase).toContain(phrase);
    }
  });

  it("keeps to the copy rules", () => {
    expect(page).not.toMatch(/backtest|\bearn|\byield|\bAPY\b|guarantee|prototype|Turnkey|fee wallet/i);
  });
});
