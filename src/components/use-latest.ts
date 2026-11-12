"use client";

import { useRef, type MutableRefObject } from "react";

/** A ref that always holds the latest `value` (the mirror-ref pattern). */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  // Assign during render so later effects in the same commit see the latest value.
  // This is earlier (and safer for callback refs) than writing inside useEffect.
  // eslint-disable-next-line react-hooks/refs -- intentional useLatest mirror
  ref.current = value;
  return ref;
}
