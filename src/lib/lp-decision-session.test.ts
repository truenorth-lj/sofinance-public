import { expect, it } from "vitest";
import { DecisionSession } from "./lp-decision-session";
it("ignores old responses after amount/date/pool change or cancel, suppresses duplicate clicks, and allows retry", () => {
  const session = new DecisionSession(); const old = session.begin()!;
  expect(session.begin()).toBeNull(); session.cancel();
  expect(old.signal.aborted).toBe(true); expect(old.current()).toBe(false);
  const next = session.begin()!; old.finish(); expect(session.begin()).toBeNull();
  expect(next.current()).toBe(true); next.finish(); expect(session.begin()).not.toBeNull();
});
