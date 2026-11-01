/**
 * Browser side of My positions for DEXes served through the registry (DESIGN.md §1.3, PR5). Client-safe: no SDK, no
 * server code. Positions come from `POST /api/dex/<id>/positions`; the UI only reads the unified shape, the descriptor
 * and its capabilities, never a DEX id.
 */
import { shortMint, tokenSymbol, type PositionLabelMetadata } from "@/lib/position-label";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexDescriptor, DexSigner } from "./types";

/** DEXes whose positions this wallet type can list, minus sources the page already reads another way (`exclude`). */
export function positionDescriptorsFor(descriptors: readonly DexDescriptor[], signer: DexSigner, exclude: readonly string[] = []): DexDescriptor[] {
  return descriptors.filter((descriptor) => descriptor.capabilities.signer === signer && !exclude.includes(descriptor.id));
}

const isPosition = (value: unknown, descriptor: DexDescriptor): value is UnifiedPosition => {
  const item = value as Partial<UnifiedPosition> | null;
  return Boolean(item && typeof item.key === "string" && item.source === descriptor.id && item.chain === descriptor.chain
    && typeof item.nativeId === "string" && typeof item.liquidity === "string" && item.tokenA && item.tokenB && item.range);
};

/**
 * The wallet's positions in one DEX, or `null` when this deployment does not serve the DEX (404: the route is off, as in
 * production today, or the DEX is not registered); the page then treats the DEX as not enabled. Any other failure throws
 * with the server's plain message.
 */
export async function fetchDexPositions(descriptor: DexDescriptor, owner: string, init: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<UnifiedPosition[] | null> {
  const response = await (init.fetch ?? fetch)(`/api/dex/${encodeURIComponent(descriptor.id)}/positions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: init.signal, cache: "no-store",
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null) as { positions?: unknown; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" && body.error ? body.error : `${descriptor.displayName} positions could not be loaded.`);
  }
  if (!Array.isArray(body?.positions) || !body.positions.every((item) => isPosition(item, descriptor))) {
    throw new Error(`${descriptor.displayName} returned positions in an unexpected shape.`);
  }
  return body.positions;
}

const EN_DASH = "–";
function priceText(value: number, digits: number) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(digits) : "—";
}
function rangeDigits(lower: number, upper: number) {
  const span = Math.abs(upper - lower);
  if (Number.isFinite(span) && span > 0) return Math.min(8, Math.max(4, Math.ceil(-Math.log10(span))));
  return 4;
}

/** `TSLA/TSLAx · range 0.9871–1.0472` (price mode) or `ticks -10 to 10` (tick mode). */
export function dexPositionRangeText(position: Pick<UnifiedPosition, "range">): string {
  const { range } = position;
  if (range.mode === "tick") return `ticks ${range.tickLower} to ${range.tickUpper}`;
  const digits = rangeDigits(range.lower, range.upper);
  return `range ${priceText(range.lower, digits)}${EN_DASH}${priceText(range.upper, digits)}`;
}

const STATUS_TEXT = { in: "In range", below: "Below range", above: "Above range", unknown: null } as const;

/** Dropdown label for a registry position (rows.ts adds the DEX name and "Closed"). */
export function dexPositionLabel(position: UnifiedPosition, metadata?: PositionLabelMetadata): string {
  const parts = [`${tokenSymbol(position.tokenA.id, metadata, position.tokenA.symbol)}/${tokenSymbol(position.tokenB.id, metadata, position.tokenB.symbol)}`,
    dexPositionRangeText(position)];
  const status = STATUS_TEXT[position.rangeStatus];
  if (status) parts.push(status);
  parts.push(`#${shortMint(position.nativeId)}`);
  return parts.join(" · ");
}

export function dexRangeStatusText(position: Pick<UnifiedPosition, "rangeStatus">): string | null {
  return STATUS_TEXT[position.rangeStatus];
}
