import type { EvmPositionScanResult, EvmPositionValuesResult } from "@/lib/evm-position-types";

/** Native holdings/amount reads retain their HTTP DTOs and existing deployment admission. */
export type NativeEvmPositionReads = {
  enabled: () => boolean;
  parseIds: (raw: string | null) => bigint[] | null;
  scanFailedMessage: string;
  scan: (wallet: `0x${string}`, options: { fresh?: boolean }) => Promise<EvmPositionScanResult>;
  values: (ids: bigint[]) => Promise<EvmPositionValuesResult>;
};
export type EvmPositionReadPolicy = Readonly<Pick<NativeEvmPositionReads, "parseIds" | "scanFailedMessage">>;

/** Native readers supply their original public message/name; transports only need the retry interval. */
export class PositionReadBusyError extends Error {
  constructor(readonly retryAfterMs: number, message: string) { super(message); }
}
