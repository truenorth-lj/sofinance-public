import "@/lib/engine-host";
import "server-only";
import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import { rpcReadConnection } from "@sofinance/engine/rpc";
import type { ReadAddState } from "../selected-read";

export const readRaydiumAddState: ReadAddState = ({ wallet, selection }) =>
  readSelectedPositionState(wallet, selection, rpcReadConnection());
