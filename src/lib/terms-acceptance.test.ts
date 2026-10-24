import { describe, expect, it } from "vitest";
import { hasAcceptedTerms, recordTermsAcceptance, TERMS_ATTESTATION, TERMS_STORAGE_KEY, TERMS_VERSION } from "./terms-acceptance";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
};

describe("terms acceptance", () => {
  it("uses the exact checkbox wording, with no residency or region claim", () => {
    expect(TERMS_ATTESTATION).toBe("I have read and agree to the Terms of Service");
    expect(TERMS_ATTESTATION).not.toMatch(/resident|region|United States|Taiwan/i);
  });

  it("persists acceptance with the current version", () => {
    const storage = memory();
    expect(hasAcceptedTerms(storage)).toBe(false);
    recordTermsAcceptance(storage, new Date("2026-10-19T00:00:00Z"));
    expect(hasAcceptedTerms(storage)).toBe(true);
    expect(JSON.parse(storage.data.get(TERMS_STORAGE_KEY)!)).toMatchObject({ version: TERMS_VERSION, acceptedAt: "2026-10-19T00:00:00.000Z" });
  });

  it("asks again after a version bump or corrupt data", () => {
    const storage = memory();
    storage.setItem(TERMS_STORAGE_KEY, JSON.stringify({ version: "old" }));
    expect(hasAcceptedTerms(storage)).toBe(false);
    // Acceptances stored by the reverted #112 region attestation must not count for the new wording.
    storage.setItem(TERMS_STORAGE_KEY, JSON.stringify({ version: "2026-10-19", acceptedAt: "2026-10-23T08:00:00.000Z" }));
    expect(hasAcceptedTerms(storage)).toBe(false);
    storage.setItem(TERMS_STORAGE_KEY, "{not json");
    expect(hasAcceptedTerms(storage)).toBe(false);
    expect(hasAcceptedTerms(null)).toBe(false);
  });
});
