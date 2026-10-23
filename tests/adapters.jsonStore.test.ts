import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../src/adapters/jsonStore";

type Thing = { version: 1; items: string[] };
const fallback = (): Thing => ({ version: 1, items: [] });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rehearsal-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("JsonStore", () => {
  it("returns the fallback for a missing file without creating it", () => {
    const store = new JsonStore<Thing>(join(dir, "a.json"), fallback);
    expect(store.exists()).toBe(false);
    expect(store.read()).toEqual({ version: 1, items: [] });
    expect(store.exists()).toBe(false);
  });

  it("round trips a value", () => {
    const store = new JsonStore<Thing>(join(dir, "a.json"), fallback);
    store.write({ version: 1, items: ["x", "y"] });
    expect(store.read()).toEqual({ version: 1, items: ["x", "y"] });
  });

  it("creates parent directories", () => {
    const store = new JsonStore<Thing>(join(dir, "deep", "nested", "a.json"), fallback);
    store.write(fallback());
    expect(store.exists()).toBe(true);
  });

  it("leaves no temp file behind", () => {
    const store = new JsonStore<Thing>(join(dir, "a.json"), fallback);
    store.write(fallback());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("overwrites rather than appending", () => {
    const store = new JsonStore<Thing>(join(dir, "a.json"), fallback);
    store.write({ version: 1, items: ["first"] });
    store.write({ version: 1, items: ["second"] });
    expect(store.read().items).toEqual(["second"]);
  });

  // Fail closed: a corrupt bank file holds purchases that each cost a human
  // click, so it must never be quietly replaced with an empty one.
  it("throws on malformed JSON instead of falling back", () => {
    const path = join(dir, "a.json");
    writeFileSync(path, "{ not json", "utf8");
    const store = new JsonStore<Thing>(path, fallback);
    expect(() => store.read()).toThrow(/not valid JSON/i);
    expect(() => store.read()).toThrow(/a\.json/);
    expect(existsSync(path)).toBe(true);
  });
});
