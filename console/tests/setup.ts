import { afterEach } from "vitest";
import { closeOpenDbs } from "./pg";

// Close the in-process Postgres instances each test opened (see tests/pg.ts).
afterEach(closeOpenDbs);
