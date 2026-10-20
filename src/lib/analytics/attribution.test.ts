import { describe, expect, it } from "vitest";
import {
  FIRST_TOUCH_KEY,
  getStoredAttribution,
  parseAttribution,
  readAndStoreFirstTouch,
  resolveFirstTouch,
} from "./attribution";

function memory() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    store,
  };
}

describe("attribution parsing and first-touch persistence", () => {
  it("parses ref=x-<slug> and standard utm_* params", () => {
    expect(parseAttribution("?ref=x-colosseum&utm_source=twitter&utm_medium=social&utm_campaign=launch")).toEqual({
      ref: "x-colosseum",
      utm_source: "twitter",
      utm_medium: "social",
      utm_campaign: "launch",
    });
  });

  it("drops empty, overlong, or unsafe values", () => {
    expect(parseAttribution("?ref=x-ok<script>&utm_source=")).toEqual({});
    expect(parseAttribution(`?ref=${"a".repeat(65)}`)).toEqual({});
  });

  it("keeps the first non-empty attribution across later navigation", () => {
    const storage = memory();
    const first = readAndStoreFirstTouch("?ref=x-first&utm_source=twitter", storage);
    const later = readAndStoreFirstTouch("?ref=x-second&utm_campaign=other", storage);
    expect(first).toEqual({ ref: "x-first", utm_source: "twitter" });
    expect(later).toEqual(first);
    expect(getStoredAttribution(storage)).toEqual(first);
    expect(storage.store.get(FIRST_TOUCH_KEY)).toContain("x-first");
  });

  it("adopts the first attributed touch if the first visit had no params", () => {
    expect(resolveFirstTouch({}, { ref: "x-later" })).toEqual({ ref: "x-later" });
    expect(resolveFirstTouch({ ref: "x-first" }, { ref: "x-later" })).toEqual({ ref: "x-first" });
  });
});
