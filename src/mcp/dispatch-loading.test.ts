import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/withdraw/build", () => { throw new Error("withdraw build must stay lazy"); });
vi.mock("@/lib/withdraw/send", () => { throw new Error("withdraw send must stay lazy"); });
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => { throw new Error("RPC must not be created at registration"); } }));
vi.mock("@sofinance/engine/config/server-env", async importOriginal => ({
  ...await importOriginal<typeof import("@sofinance/engine/config/server-env")>(),
  getSigningSecret: () => { throw new Error("signing secret must not be read at registration"); },
}));
it("loads real handlers and registers the SDK without signing/RPC or eager withdrawal imports", async () => {
  const { TOOL_DISPATCH } = await import("./dispatch");
  const { createMcpServer } = await import("./create-server");
  expect(Object.keys(TOOL_DISPATCH)).toHaveLength(15);
  const server = createMcpServer();
  await server.close();
});
