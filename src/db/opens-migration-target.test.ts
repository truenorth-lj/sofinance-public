import { describe, expect, it } from "vitest";
import { opensMigrationTarget } from "./opens-migration-target";
const direct = "postgres://owner:dummy@ep-example.ap-southeast-1.aws.neon.tech/opens?sslmode=require";
const runtime = "postgres://writer:dummy@ep-example-pooler.ap-southeast-1.aws.neon.tech/opens?sslmode=require";
describe("opens migration target", () => {
  it("accepts the matching direct endpoint with a separate migration role and verified TLS", () => {
    const target = opensMigrationTarget(direct, runtime);
    expect(target.expected).toEqual({ database: "opens", role: "owner" });
    expect(target.ssl).toEqual({ rejectUnauthorized: true, servername: "ep-example.ap-southeast-1.aws.neon.tech" });
    expect(new URL(target.url).search).toBe("");
  });
  it("allows the loopback disposable test database", () => {
    const url = "postgres://tester@127.0.0.1:56789/opens";
    expect(opensMigrationTarget(url, url).ssl).toBe(false);
  });
  it.each([[undefined, runtime], [direct, undefined]])("requires explicit migration and runtime targets", (migration, application) => {
    expect(() => opensMigrationTarget(migration, application)).toThrow(/is required/);
  });
  it.each([runtime.replace('/opens', '/wrong'), runtime.replace('ep-example-', 'ep-other-'), runtime.replace('/opens', ':5433/opens')])("rejects a different runtime database", target => {
    expect(() => opensMigrationTarget(direct, target)).toThrow();
  });
  it.each([runtime, direct + '&options=-c%20search_path=wrong', direct + '&sslmode=disable',
    direct.replace('ep-example.', 'ep-example%2Cevil.'), direct.replace('postgres:', 'https:'), direct + '#fragment'])
    ("rejects pooling, unsafe options and malformed target", target => {
      expect(() => opensMigrationTarget(target, runtime)).toThrow();
    });
});
