import { unsupportedTokenReason } from "@/lib/unified-pools/model";
import { dexDescriptors, uiFor, type DexDescriptor } from "@/lib/dex/client";

/** The shell the pools-page Open button or a `?openPool=` deep link actually invokes. */
export type OpenHandlerKind = "unsupported" | "none" | "registry" | "native-modal" | "rhc-dialog";
export type OpenHandler = { handler: OpenHandlerKind; reason?: string };

/** Enough of a pool to decide the open path; `protocol` is a string so unknown spellings can be tested. */
export type PoolOpenRef = {
  protocol: string;
  chain: string;
  unsupportedIssues?: readonly string[];
};

export type OpenDispatchDeps = {
  descriptorFor?: (id: string) => (Pick<DexDescriptor, "capabilities"> & Partial<Pick<DexDescriptor, "ui">>) | null;
};

export type PoolOpenDispatch = {
  button: OpenHandler;
  deepLink: OpenHandler;
};

/**
 * Call-for-call equivalent of the pools-page Open button (`actionFor`) and the `?openPool=` deep link.
 * Both entry points resolve to the same handler (the deep link does not auto-connect; that is not a handler change).
 *
 * E-dispatch: routes through `uiFor` / `openUi` instead of descriptor presence. The matrix in
 * `open-dispatch.test.ts` was locked against the pre-rewire path and must stay identical.
 */
export function resolveOpenDispatch(pool: PoolOpenRef, deps: OpenDispatchDeps = {}): PoolOpenDispatch {
  const descriptorFor = deps.descriptorFor ?? ((id) => dexDescriptors.descriptorFor(id));
  const both = (handler: OpenHandler): PoolOpenDispatch => ({ button: handler, deepLink: handler });

  const unsupported = unsupportedTokenReason(pool);
  if (unsupported) return both({ handler: "unsupported", reason: unsupported });

  const ui = uiFor(pool.protocol, { descriptorFor });
  if (ui.openUi === "registry") {
    const open = descriptorFor(pool.protocol)?.capabilities.open;
    if (!open?.supported) return both({ handler: "none", reason: open?.reason ?? "Opening is not available yet" });
    return both({ handler: "registry" });
  }
  if (ui.openUi === "rhc-dialog") return both({ handler: "rhc-dialog" });
  if (ui.openUi === "native-modal") return both({ handler: "native-modal" });
  return both({ handler: "none", reason: "Opening is not available yet" });
}
