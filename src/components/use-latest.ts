"use client";

import { useRef, type MutableRefObject } from "react";

/** A ref that always holds the latest `value` (the mirror-ref pattern). */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
