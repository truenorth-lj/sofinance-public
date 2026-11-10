// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlipRows } from "./use-flip-rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Rows are 40 px apart; happy-dom has no layout, so offsetTop comes from each row's place in the list. */
function List({ keys }: { keys: string[] }) {
  const ref = useRef<HTMLUListElement | null>(null);
  useFlipRows(ref, "li[data-pool]");
  return <ul ref={ref}>{keys.map((key) => <li key={key} data-pool={key}>{key}</li>)}</ul>;
}

let host: HTMLDivElement; let root: Root;
let calls: { key: string | null; frames: Keyframe[] }[];
let reduce = false;

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  calls = []; reduce = false;
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get(this: HTMLElement) {
    return this.parentElement ? [...this.parentElement.children].indexOf(this) * 40 : 0;
  } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.children.length * 40; } });
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
    calls.push({ key: this.getAttribute("data-pool"), frames });
    return { cancel: vi.fn() } as unknown as Animation;
  }) as unknown as HTMLElement["animate"];
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = (keys: string[]) => act(() => root.render(<List keys={keys} />));
const shiftOf = (key: string) => calls.find((call) => call.key === key)?.frames[0]?.transform;

describe("useFlipRows", () => {
  it("does nothing on the first render or when the order is unchanged", () => {
    render(["a", "b", "c"]);
    render(["a", "b", "c"]);
    expect(calls).toHaveLength(0);
  });

  it("slides rows that moved from their old place, raises new rows, and eases the list's height", () => {
    render(["a", "b", "c"]);
    render(["c", "a", "d"]);
    expect(shiftOf("c")).toBe("translateY(80px)"); // was 80 px down, now at the top
    expect(shiftOf("a")).toBe("translateY(-40px)");
    expect(shiftOf("d")).toBe("translateY(10px)"); // new: rises into place, no opacity
    expect(calls.find((call) => call.key === "d")!.frames[0]).not.toHaveProperty("opacity");
    render(["c"]);
    const box = calls.filter((call) => call.key === null).at(-1)!;
    expect(box.frames).toEqual([{ height: "120px", overflow: "hidden" }, { height: "40px", overflow: "hidden" }]);
  });

  it("keeps still with reduced motion", () => {
    reduce = true;
    render(["a", "b"]);
    render(["b", "a"]);
    expect(calls).toHaveLength(0);
  });
});
