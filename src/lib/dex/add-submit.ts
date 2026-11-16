/** Internal signed-add validation, after the transport's permit and message checks. */
import type { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { SelectedPermitInput } from "@/lib/selected-permit";

// Trusted compatibility transports choose these; never accept them from request input.
export const APP_SELECTED_SUBMIT = "app-selected-submit";
export const MCP_SELECTED_SUBMIT = "mcp-selected-submit";
export type SelectedSubmitProfile = typeof APP_SELECTED_SUBMIT | typeof MCP_SELECTED_SUBMIT;
export type AddValidationCommand = {
  transaction: VersionedTransaction;
  wallet: PublicKey;
  permitInput: SelectedPermitInput;
  prepared?: VersionedTransaction;
};
export type SelectedSubmitCommand = AddValidationCommand & { walletSignature: Uint8Array };
/** Preserves signed transaction and Connection identities; does not authorize or broadcast. */
export type ValidateSignedAdd = (command: AddValidationCommand, connection: Connection, profile: SelectedSubmitProfile) => Promise<void>;
