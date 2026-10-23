import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Small JSON file store for the purchase bank and run state.
 *
 * A malformed file THROWS rather than falling back to the default. Silently
 * resetting a corrupt bank file would discard approved purchases that cost a
 * human click each, and silently resetting run state would re-run steps that
 * already moved money.
 */
export class JsonStore<T> {
  readonly path: string;
  readonly #fallback: () => T;

  constructor(path: string, fallback: () => T) {
    this.path = path;
    this.#fallback = fallback;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): T {
    if (!existsSync(this.path)) return this.#fallback();
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      throw new Error(`could not read ${this.path}: ${(e as Error).message}`);
    }
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      throw new Error(
        `${this.path} is not valid JSON and will not be overwritten automatically: ${(e as Error).message}`,
      );
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write beside the target then rename, so a crash mid-write cannot leave a
    // half-written bank or run-state file behind.
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      renameSync(temp, this.path);
    } catch (e) {
      rmSync(temp, { force: true });
      throw new Error(`could not replace ${this.path}: ${(e as Error).message}`);
    }
  }
}
