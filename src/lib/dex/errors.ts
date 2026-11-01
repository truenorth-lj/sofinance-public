import { NOT_AVAILABLE_MESSAGE } from "@/lib/unified-positions/model";

export type DexErrorCode =
  | "UNSUPPORTED"
  /** A token's issuer controls block this action (transfer hook set, transfers paused, transfer fee). */
  | "TOKEN_RESTRICTED"
  /** The range is outside what this DEX opens in one position. */
  | "RANGE_UNSUPPORTED"
  /** The open would have to create a shared on-chain account first. */
  | "NEEDS_NEW_SHARED_ACCOUNT"
  | "INPUT_TOKEN_UNSUPPORTED"
  | "POSITION_NOT_FOUND"
  /** The wallet lacks the tokens or SOL this action needs. */
  | "INSUFFICIENT_FUNDS"
  /** The request itself is malformed (bad address, zero amount, missing cosigner key). */
  | "INVALID_REQUEST"
  | "UPSTREAM";

/** Every error a DEX adapter throws; `message` is plain English safe to show the user. */
export class DexError extends Error {
  constructor(readonly code: DexErrorCode, message: string) {
    super(message);
    this.name = "DexError";
  }
}

export class DexUnsupportedError extends DexError {
  constructor(reason: string = NOT_AVAILABLE_MESSAGE) {
    super("UNSUPPORTED", reason);
    this.name = "DexUnsupportedError";
  }
}
