import type { RpcLogger } from "./types";

let logger: RpcLogger = () => undefined;

export function setRpcLogger(next: RpcLogger | null): void {
  logger = next ?? (() => undefined);
}

export function emitRpcLog(...args: Parameters<RpcLogger>): void {
  logger(...args);
}
