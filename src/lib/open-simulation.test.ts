import { SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { simulatedAccount } from "./open-simulation";

it("treats a closed zero-lamport WSOL account returned by simulation as absent", () => {
  expect(simulatedAccount({ data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: 0, executable: false })).toBeNull();
  expect(simulatedAccount(null)).toBeNull();
});
it("does not silently discard malformed or funded token accounts", () => {
  expect(() => simulatedAccount({ data: ["", "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 0, executable: false })).toThrow("data missing");
  expect(() => simulatedAccount({ data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: 1, executable: false })).toThrow("data missing");
  const data = Buffer.alloc(165, 1);
  expect(simulatedAccount({ data: [data.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 2039280, executable: false })?.data).toEqual(data);
});
