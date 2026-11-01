/**
 * Browser side of My positions for DEXes served through the registry (DESIGN.md §1.3, PR5). Client-safe: no SDK, no
 * server code. Positions come from `POST /api/dex/<id>/positions`; the UI only reads the unified shape, the descriptor
 * and its capabilities, never a DEX id.
 */
import { shortMint, tokenSymbol, type PositionLabelMetadata } from "@/lib/position-label";
import type { PositionHoldings, UnifiedPosition } from "@/lib/unified-positions/model";
import type { PositionPerformance } from "./adapter";
import type { DexDescriptor, DexSigner } from "./types";

/** DEXes whose positions this wallet type can list, minus sources the page already reads another way (`exclude`). */
export function positionDescriptorsFor(descriptors: readonly DexDescriptor[], signer: DexSigner, exclude: readonly string[] = []): DexDescriptor[] {
  return descriptors.filter((descriptor) => descriptor.capabilities.signer === signer && !exclude.includes(descriptor.id));
}

const isRawPair = (value: unknown) => value === null
  || Boolean(value && typeof value === "object" && ["a", "b"].every((side) => {
    const raw = (value as Record<string, unknown>)[side];
    return typeof raw === "string" && /^\d{1,80}$/.test(raw);
  }));
const isHoldings = (value: unknown) => value === undefined
  || Boolean(value && typeof value === "object" && isRawPair((value as PositionHoldings).liquidityRaw) && isRawPair((value as PositionHoldings).unclaimedFeesRaw));

const isPosition = (value: unknown, descriptor: DexDescriptor): value is UnifiedPosition => {
  const item = value as Partial<UnifiedPosition> | null;
  return Boolean(item && typeof item.key === "string" && item.source === descriptor.id && item.chain === descriptor.chain
    && typeof item.nativeId === "string" && typeof item.liquidity === "string" && item.tokenA && item.tokenB && item.range
    && isHoldings(item.holdings) && (item.closeRefundLamports === undefined || (typeof item.closeRefundLamports === "string" && /^\d{1,20}$/.test(item.closeRefundLamports))));
};

/**
 * The wallet's positions in one DEX, or `null` when this deployment does not serve the DEX: only a 404 whose body has no
 * error `code` (the route is off, as in production today, or the DEX / op is not registered); the page then treats the
 * DEX as not enabled. A coded 404 (e.g. `POSITION_NOT_FOUND` from the adapter) and every other failure throw with the
 * server's plain message.
 */
export async function fetchDexPositions(descriptor: DexDescriptor, owner: string, init: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<UnifiedPosition[] | null> {
  const response = await (init.fetch ?? fetch)(`/api/dex/${encodeURIComponent(descriptor.id)}/positions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: init.signal, cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { positions?: unknown; error?: unknown; code?: unknown } | null;
  if (response.status === 404 && (body?.code === undefined || body?.code === null)) return null;
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" && body.error ? body.error : `${descriptor.displayName} positions could not be loaded.`);
  }
  if (!Array.isArray(body?.positions) || !body.positions.every((item) => isPosition(item, descriptor))) {
    throw new Error(`${descriptor.displayName} returned positions in an unexpected shape.`);
  }
  return body.positions;
}

const isUsd = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
const isReport = (value: unknown) => value === undefined || Boolean(value && typeof value === "object"
  && typeof (value as Record<string, unknown>).poolId === "string" && typeof (value as Record<string, unknown>).mintA === "string"
  && typeof (value as Record<string, unknown>).mintB === "string" && (value as Record<string, unknown>).metrics
  && typeof (value as Record<string, unknown>).metrics === "object");

/**
 * One position's performance (`POST /api/dex/<id>/performance`, PR9). Read-only. Throws with the server's plain message
 * on any failure (a disabled route included: the Performance tab is only offered where positions were listed).
 */
export async function fetchDexPerformance(descriptor: DexDescriptor, positionKey: string, init: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<PositionPerformance> {
  const response = await (init.fetch ?? fetch)(`/api/dex/${encodeURIComponent(descriptor.id)}/performance`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionKey }), signal: init.signal, cache: "no-store",
  });
  const body = await response.json().catch(() => null) as (Partial<PositionPerformance> & { error?: unknown }) | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" && body.error ? body.error : `${descriptor.displayName} performance could not be loaded.`);
  }
  const fields = ["depositedUsd", "withdrawnUsd", "feesClaimedUsd", "feesUnclaimedUsd", "currentValueUsd", "pnlUsd"] as const;
  if (!body || body.key !== positionKey || typeof body.partial !== "boolean" || !fields.every((field) => isUsd(body[field])) || !isReport(body.report)) {
    throw new Error(`${descriptor.displayName} returned performance in an unexpected shape.`);
  }
  return body as PositionPerformance;
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
