import { randomUUID } from "node:crypto";

/**
 * In-memory arrival ledger.
 *
 * Honest limitation, and the gate is built to respect it: this lives in one
 * serverless instance's memory. If Vercel spreads the five events across two
 * instances, a read from one cannot see rows written to the other. That is why
 * every row carries INSTANCE_ID and why the gate treats a multi-instance ledger
 * with anything missing as ambiguous rather than as a lost event.
 */

export const INSTANCE_ID = randomUUID().slice(0, 8);
export const BOOTED_AT_MS = Date.now();

const MAX_ROWS = 500;

export type Row = {
  eventId: string | null;
  eventType: string | null;
  receivedAtMs: number;
  /** null when the receiver holds no credentials and so could not verify. */
  verified: boolean | null;
  verifyDetail: string;
  resourceId: string | null;
  transmissionId: string | null;
  instanceId: string;
};

const rows: Row[] = [];

export function append(row: Omit<Row, "instanceId">): void {
  rows.push({ ...row, instanceId: INSTANCE_ID });
  // Bounded so a flood cannot grow the heap without limit.
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
}

export function snapshot(): Row[] {
  return [...rows];
}
