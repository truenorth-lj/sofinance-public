import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type ConnectionOptions } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rwaConnectionTarget } from "./connection";

const railway = "postgresql://sofinance_owner:dummy@nozomi.proxy.rlwy.net:24169/sofinance";
const neon = "postgresql://sofinance_owner:dummy@ep-public-test.ap-southeast-1.aws.neon.tech/sofinance";
const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe("Railway TCP proxy target", () => {
  it("is refused on a managed (Vercel / neon mode) runtime without a pinned CA", () => {
    expect(() => rwaConnectionTarget(railway, "sofinance_owner", true)).toThrow("direct Neon");
  });
  it("is admitted with a pinned CA, always TLS, CA-only trust, options stripped", () => {
    const target = rwaConnectionTarget(`${railway}?sslmode=require`, "sofinance_owner", true, pem);
    expect(target.url).toBe(railway);
    expect(target.ssl).toMatchObject({ ca: pem, rejectUnauthorized: true, servername: "nozomi.proxy.rlwy.net" });
    expect(target.ssl && typeof target.ssl.checkServerIdentity).toBe("function");
  });
  it("still rejects unsafe URL options, other roles and other databases", () => {
    expect(() => rwaConnectionTarget(`${railway}?sslmode=disable`, "sofinance_owner", true, pem)).toThrow("Invalid RWA database connection options");
    expect(() => rwaConnectionTarget(railway.replace("sofinance_owner:", "postgres:"), "sofinance_owner", true, pem)).toThrow();
    expect(() => rwaConnectionTarget(railway.replace("/sofinance", "/railway"), "sofinance_owner", true, pem)).toThrow();
  });
  it.each([
    "postgresql://sofinance_owner:dummy@proxy.rlwy.net.attacker.invalid:24169/sofinance",
    "postgresql://sofinance_owner:dummy@attacker.invalid:24169/sofinance",
    "postgresql://sofinance_owner:dummy@a.b.proxy.rlwy.net:24169/sofinance",
  ])("does not let a pinned CA admit another host on a managed runtime: %s", (url) => {
    expect(() => rwaConnectionTarget(url, "sofinance_owner", true, pem)).toThrow("direct Neon");
  });
  it("leaves Neon on system-root CA + hostname verification even when a CA pin is configured", () => {
    expect(rwaConnectionTarget(neon, "sofinance_owner", true, pem).ssl)
      .toEqual({ rejectUnauthorized: true, servername: "ep-public-test.ap-southeast-1.aws.neon.tech" });
  });
});

// Real TLS handshakes against a Railway-shaped server: root-ca -> leaf (SAN localhost only).
let dir = "";
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"]); return true; } catch { return false; } })();
function issue(name: string) {
  const f = (s: string) => join(dir, `${name}.${s}`);
  execFileSync("openssl", ["req", "-new", "-x509", "-days", "2", "-nodes", "-subj", "/CN=root-ca", "-keyout", f("root.key"), "-out", f("root.crt")], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-nodes", "-subj", "/CN=localhost", "-keyout", f("key"), "-out", f("csr")], { stdio: "ignore" });
  writeFileSync(f("ext"), "subjectAltName=DNS:localhost,DNS:postgres.railway.internal\n");
  execFileSync("openssl", ["x509", "-req", "-in", f("csr"), "-CA", f("root.crt"), "-CAkey", f("root.key"), "-CAcreateserial", "-days", "2", "-extfile", f("ext"), "-out", f("crt")], { stdio: "ignore" });
  return { ca: readFileSync(f("root.crt"), "utf8"), key: readFileSync(f("key")), cert: readFileSync(f("crt")) };
}
async function handshake(server: { key: Buffer; cert: Buffer }, ssl: ConnectionOptions) {
  const srv = createServer({ key: server.key, cert: server.cert }, (s) => s.end());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    return await new Promise<string>((resolve) => {
      const sock = connect({ ...ssl, host: "127.0.0.1", port }, () => { sock.destroy(); resolve("ok"); });
      sock.on("error", (e) => resolve(e.message));
    });
  } finally { srv.close(); }
}

describe.skipIf(!hasOpenssl)("pinned CA handshake", () => {
  let good: ReturnType<typeof issue>, other: ReturnType<typeof issue>;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "rwa-tls-")); good = issue("good"); other = issue("other"); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("connects to the server signed by the pinned CA through the proxy hostname", async () => {
    const { ssl } = rwaConnectionTarget(railway, "sofinance_owner", true, good.ca);
    expect(await handshake(good, ssl as ConnectionOptions)).toBe("ok");
  });
  it("refuses a server signed by any other CA", async () => {
    const { ssl } = rwaConnectionTarget(railway, "sofinance_owner", true, good.ca);
    expect(await handshake(other, ssl as ConnectionOptions)).not.toBe("ok");
  });
});
