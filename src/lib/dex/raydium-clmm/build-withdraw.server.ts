import "@/lib/engine-host";
import "server-only";
import { buildWithdraw } from "@sofinance/engine/withdraw/build";
import type { BuildWithdrawal } from "../withdraw-prepare";

/** One binding for preview, app and MCP; the engine owns parsing, simulation and receipt validation. */
export const buildRaydiumWithdrawal: BuildWithdrawal = (command, preview) =>
  preview === undefined ? buildWithdraw(command) : buildWithdraw(command, preview);
