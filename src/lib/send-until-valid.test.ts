import { describe, expect, it, vi } from "vitest";
import { FIRST_SEND_OPTIONS, REBROADCAST_OPTIONS, sendUntilObserved } from "./send-until-valid";

describe("sendUntilObserved", () => {
  it("returns after the first send when the signature is already confirmed", async () => {
    const connection = {
      sendRawTransaction: vi.fn(async () => "sig"),
      getBlockHeight: vi.fn(async () => 100),
      getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "confirmed" }] })),
    };
    await expect(sendUntilObserved(connection as never, Buffer.from("tx"), 150)).resolves.toBe("sig");
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(Buffer.from("tx"), FIRST_SEND_OPTIONS);
  });

  it("rebroadcasts the same bytes until the signature is observed", async () => {
    const connection = {
      sendRawTransaction: vi.fn(async () => "sig"),
      getBlockHeight: vi.fn(async () => 100),
      getSignatureStatuses: vi.fn()
        .mockResolvedValueOnce({ value: [null] })
        .mockResolvedValueOnce({ value: [{ confirmationStatus: "processed" }] }),
    };
    const sleep = vi.fn(async () => undefined);
    await expect(sendUntilObserved(connection as never, Buffer.from("tx"), 150, { sleep })).resolves.toBe("sig");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(connection.sendRawTransaction).toHaveBeenLastCalledWith(Buffer.from("tx"), REBROADCAST_OPTIONS);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("stops rebroadcasting once lastValidBlockHeight has passed and still returns the signature", async () => {
    const connection = {
      sendRawTransaction: vi.fn(async () => "sig"),
      getBlockHeight: vi.fn(async () => 151),
      getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    };
    await expect(sendUntilObserved(connection as never, Buffer.from("tx"), 150)).resolves.toBe("sig");
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
  });
});
