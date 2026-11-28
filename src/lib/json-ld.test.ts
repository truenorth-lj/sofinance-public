import { describe, expect, it } from "vitest";
import { homeJsonLd, serializeJsonLd } from "./json-ld";

describe("homeJsonLd", () => {
  const graph = homeJsonLd()["@graph"] as Record<string, unknown>[];
  const app = graph.find((node) => node["@type"] === "SoftwareApplication");

  it("adds a SoftwareApplication node with FinanceApplication / Web offers", () => {
    expect(app).toMatchObject({
      "@type": "SoftwareApplication",
      name: "SoFinance",
      url: "https://sofinancelab.xyz",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
    });
    expect(app?.offers).toMatchObject({
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Zero performance fee. Self-custodial.",
    });
  });

  it("does not name a team, location, or other restricted phrases", () => {
    const text = serializeJsonLd(homeJsonLd());
    expect(text).not.toMatch(/open[- ]source|github|Turnkey|fee wallet|prototype|Taiwan|Taipei|location/i);
  });
});
