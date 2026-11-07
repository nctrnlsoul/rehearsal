import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "../src/mcp/server";

/**
 * One version everywhere a reader or a client can see one: every package, the
 * MCP server's handshake, the README's status line and the trust panel.
 */

const ROOT = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const pkg = (dir: string) => (JSON.parse(read(dir, "package.json")) as { version: string; license?: string });

describe("the version", () => {
  const version = pkg(".").version;

  it("is one number across the packages, the MCP server, the README and the trust panel", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const dir of ["console", "store", "receiver"]) expect(pkg(dir).version, dir).toBe(version);
    expect(SERVER_VERSION).toBe(version);
    expect(read("README.md")).toContain(`**Status: v${version}.**`);
    expect((JSON.parse(read("console", "fixtures", "facts.json")) as { version: string }).version).toBe(`v${version}`);
  });

  it("ships every package under the license in LICENSE", () => {
    expect(read("LICENSE")).toMatch(/^MIT License/);
    for (const dir of [".", "console", "store", "receiver"]) expect(pkg(dir).license, dir).toBe("MIT");
  });
});
