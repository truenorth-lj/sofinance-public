import "@/lib/engine-host";
import "server-only";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import type { ReadCompoundState } from "../compound-read";
export const readRaydiumCompoundState: ReadCompoundState = ({ wallet, positionMint }, connection) =>
  readCompoundPositionState(wallet, positionMint, connection);
