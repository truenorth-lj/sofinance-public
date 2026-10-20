export type PositionOpenRow = {
  txSignature: string;
  openedAt?: Date;
  wallet: string;
  poolAddress: string;
  symbolA: string | null;
  symbolB: string | null;
  notionalUsd: number | null;
  sourceRef: string | null;
};

export type DailyRefOpens = {
  ref: string | null;
  opens: number;
  uniqueWallets: number;
  newUniqueWallets: number;
  notionalUsd: number | null;
};

export type DailyOpens = {
  date: string;
  opens: number;
  uniqueWallets: number;
  newUniqueWallets: number;
  notionalUsd: number | null;
  byRef: DailyRefOpens[];
};

export type OpenLogRecord = {
  day: string;
  wallet: string;
  ref: string | null;
  notionalUsd: number | null;
  openedAtMs: number;
};
