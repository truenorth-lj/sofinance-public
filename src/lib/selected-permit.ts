import { createHmac, timingSafeEqual } from "node:crypto";
import type { PositionSelection } from "./selected-state";

export type SelectedPermitInput = {
  message: string; wallet: string; selection: PositionSelection; requested: string; floorBps: number;
  expiresAt: number; lastValidBlockHeight: number; startingLiquidity: string;
  expectedLiquidity: string; rangeSide: string;
  startingBalances: { input: string; a: string; b: string };
};

function payload(input: SelectedPermitInput) {
  return ["sofinance:selected-atomic:v2", input.message, input.wallet,
    input.selection.positionMint, input.selection.inputMint, input.selection.inputKind,
    input.requested, input.floorBps, input.expiresAt, input.lastValidBlockHeight,
    input.startingLiquidity, input.expectedLiquidity, input.rangeSide,
    input.startingBalances.input, input.startingBalances.a, input.startingBalances.b].join(":");
}

export function issueSelectedPermit(secret: string, input: SelectedPermitInput) {
  if (!secret) throw new Error("Missing server signing key");
  return createHmac("sha256", secret).update(payload(input)).digest("hex");
}

export function verifySelectedPermit(secret: string, input: SelectedPermitInput, permit: string) {
  if (!/^[0-9a-f]{64}$/.test(permit)) return false;
  const expected = Buffer.from(issueSelectedPermit(secret, input), "hex");
  return timingSafeEqual(expected, Buffer.from(permit, "hex"));
}
