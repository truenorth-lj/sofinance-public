import { describe, expect, it } from "vitest";
import { hasAcceptedTerms, recordTermsAcceptance, TERMS_ATTESTATION, TERMS_STORAGE_KEY, TERMS_VERSION } from "./terms-acceptance";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
};

describe("terms acceptance", () => {
  it("uses the exact attestation wording", () => {
    expect(TERMS_ATTESTATION).toBe("I am not a resident of the United States or Taiwan, am not located in a restricted region, and agree to the Terms of Service");
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
    storage.setItem(TERMS_STORAGE_KEY, "{not json");
    expect(hasAcceptedTerms(storage)).toBe(false);
    expect(hasAcceptedTerms(null)).toBe(false);
  });
});
