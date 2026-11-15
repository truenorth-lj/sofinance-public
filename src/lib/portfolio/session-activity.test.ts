import { afterEach, describe, expect, it } from "vitest";
import { activityFor, recordActivity, resetSessionActivity } from "./session-activity";

afterEach(() => resetSessionActivity());

describe("session activity", () => {
  it("lists a position's entries newest first and updates an entry in place", () => {
    recordActivity({ id: "compound:a", positionKey: "p1", title: "Compound confirming", status: "pending", signature: "a" }, 1);
    recordActivity({ id: "add:b", positionKey: "p1", title: "Liquidity added", status: "success", signature: "b" }, 1);
    recordActivity({ id: "add:c", positionKey: "p2", title: "Liquidity added", status: "success", signature: "c" }, 2);
    recordActivity({ id: "compound:a", positionKey: "p1", title: "Compound confirmed", status: "success", signature: "a" }, 3);
    const list = activityFor("p1");
    expect(list.map((entry) => entry.id)).toEqual(["add:b", "compound:a"]);
    expect(list[1]).toMatchObject({ title: "Compound confirmed", status: "success", at: 1 });
    expect(activityFor("p2").map((entry) => entry.id)).toEqual(["add:c"]);
  });

  it("keeps one entry per transaction signature on a position, even if two writers use different ids", () => {
    recordActivity({ id: "compound:a", positionKey: "p1", title: "Compound confirming", status: "pending", signature: "a" }, 1);
    recordActivity({ id: "registry-compound:a", positionKey: "p1", title: "Compound confirmed", status: "success", signature: "a" }, 2);
    recordActivity({ id: "compound:a", positionKey: "p2", title: "Compound confirmed", status: "success", signature: "a" }, 3);
    expect(activityFor("p1")).toEqual([expect.objectContaining({ id: "registry-compound:a", status: "success", at: 1 })]);
    expect(activityFor("p2")).toHaveLength(1);
  });

  it("starts empty (nothing is stored)", () => {
    expect(activityFor("p1")).toEqual([]);
  });
});
