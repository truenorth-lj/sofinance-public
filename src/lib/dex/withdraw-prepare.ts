/** Compatibility contract for existing withdrawal transports, including signed second-stage recovery. */
import type { WithdrawPrepareRequest, WithdrawPrepared } from "@sofinance/engine/withdraw/types";

// Trusted transports select these profiles; request bodies cannot enable retries or relay permits.
export const APP_WITHDRAW_PREPARE = "app-withdraw";
export const MCP_WITHDRAW_PREPARE = "mcp-withdraw";
export type WithdrawPrepareProfile = typeof APP_WITHDRAW_PREPARE | typeof MCP_WITHDRAW_PREPARE;
export type BuildWithdrawal = (input: WithdrawPrepareRequest, preview?: boolean) => Promise<WithdrawPrepared>;
export type WithdrawalPreparation = WithdrawPrepared & { sendPermit?: string; landedPermit?: string };
