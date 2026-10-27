import { createServer } from "node:http";
import type { Socket } from "node:net";
import { request as api, type Browser, type BrowserContext, type BrowserContextOptions, type Request } from "@playwright/test";

/** A deny-only proxy: never opens an upstream socket, resolves a destination or tunnels.
 * Chromium receives this proxy when the context is CREATED, including implicit loopback
 * proxying in our pinned SDK. It remains installed through page/context destruction.
 * API forwarding is a separate client, never the browser context's proxied request client.
 */
export async function createReadonlyTransport(ignoreHTTPSErrors = false) {
  const sockets = new Set<Socket>();
  const failures: string[] = [];
  const denied = { http: 0, connect: 0, upgrade: 0 };
  const server = createServer((_req, res) => {
    denied.http++;
    res.writeHead(502, { "connection": "close", "content-type": "text/plain" });
    res.end("Readonly browser transport denied");
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (_req, socket) => { denied.connect++; socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  server.on("upgrade", (_req, socket) => { denied.upgrade++; socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  server.on("clientError", (_error, socket) => { failures.push("Readonly proxy received invalid transport"); socket.destroy(); });
  server.on("error", () => failures.push("Readonly proxy failed"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Readonly proxy has no listener");
  const proxy = { server: `http://127.0.0.1:${address.port}` };
  const stopProxy = async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); });
  };
  let client;
  try { // Explicit undefined prevents Playwright Test from inheriting the browser proxy.
    client = await api.newContext({ ignoreHTTPSErrors, proxy: undefined }); }
  catch (error) { await stopProxy(); throw error; }
  let reason = "Readonly transport closed outside policy ownership";
  let closing: Promise<void> | undefined;
  let ownerClosing = false;
  return {
    proxy, client,
    // Explicit Cookie, including empty, prevents the independent client's cookie jar
    // from injecting cookies absent from the browser request. Set-Cookie is delivered
    // by fulfill to the browser normally; no storage-state merge or credential copy.
    fetch: async (request: Request) => {
      const headers = await request.allHeaders();
      headers.cookie ??= "";
      // allHeaders is asynchronous: recheck admission immediately before the hop.
      if (ownerClosing) throw new Error(reason);
      return client.fetch(request, { headers, maxRedirects: 0, maxRetries: 0 });
    },
    ownClose: (ownReason: string) => { reason = ownReason; ownerClosing = true; },
    close: () => closing ??= (async () => {
      try { await client.dispose({ reason }); }
      catch (error) { failures.push("Readonly forwarding client dispose failed"); throw error; }
      finally { await stopProxy(); }
    })(),
    audit: () => ({ guarantee: "deny-only-browser-proxy" as const, denied: { ...denied }, failures: [...failures] }),
  };
}
export type ReadonlyTransport = Awaited<ReturnType<typeof createReadonlyTransport>>;
const transports = new WeakMap<BrowserContext, ReadonlyTransport>();

/** Only register contexts created with THIS transport.proxy; the production fixture
 * supplies it via Playwright's public proxy option. Not a hostile-test-code sandbox.
 */
export function bindReadonlyTransport(context: BrowserContext, transport: ReadonlyTransport) {
  if (context.browser()?.browserType().name() !== "chromium") throw new Error("Readonly transport is validated only for Chromium");
  if (context.pages().length || transports.has(context)) throw new Error("Readonly transport requires a fresh unbound context");
  transports.set(context, transport);
  context.once("close", () => { void transport.close().catch(() => {}); });
}
export function readonlyTransportFor(context: BrowserContext) { return transports.get(context); }

/** Supported context factory for policy controls; production retains the standard
 * Playwright context fixture (tracing, viewport, etc.) and supplies the same proxy.
 */
export async function createReadonlyContext(browser: Browser, options: Omit<BrowserContextOptions, "proxy" | "serviceWorkers" | "offline"> = {}) {
  const transport = await createReadonlyTransport(options.ignoreHTTPSErrors);
  try {
    const context = await browser.newContext({ ...options, proxy: transport.proxy, serviceWorkers: "block", offline: false });
    bindReadonlyTransport(context, transport);
    return context;
  } catch (error) { await transport.close(); throw error; }
}
