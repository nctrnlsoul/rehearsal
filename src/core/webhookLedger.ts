/**
 * Reconciles events PayPal told us it sent against events the receiver recorded.
 *
 * The important distinction this encodes: a missing event and an unreadable
 * ledger are not the same finding. If the receiver's ledger is split across
 * serverless instances, "missing" is unproven, so the verdict is ambiguous and
 * the gate does not get to claim either outcome.
 */

export type Expectation = {
  readonly eventId: string;
  readonly eventType: string;
  readonly sentAtMs: number;
};

export type Arrival = {
  readonly eventId: string;
  readonly eventType: string;
  readonly receivedAtMs: number;
  /** null when the receiver was not configured to verify signatures. */
  readonly verified: boolean | null;
  readonly instanceId: string;
};

export type Matched = {
  readonly eventId: string;
  readonly eventType: string;
  readonly latencyMs: number;
  readonly verified: boolean | null;
  readonly duplicates: number;
};

export type LedgerReport = {
  readonly verdict: "pass" | "fail" | "ambiguous";
  readonly matched: Matched[];
  readonly missing: Expectation[];
  readonly unexpected: Arrival[];
  readonly duplicateCount: number;
  readonly instanceIds: string[];
  readonly degraded: boolean;
  readonly notes: string[];
};

export type ReconcileOptions = {
  /**
   * True only when a write to the ledger has been positively read back in this
   * run. Defaults to false, because an unverified ledger cannot distinguish a
   * lost event from one it simply cannot see.
   */
  readonly ledgerVerified?: boolean;
  /**
   * True when the receiver holds credentials and so marks every row verified
   * or not (see receiverVerifies). Then only verified rows count as arrivals
   * (audit 2026-10-25 L2): the receiver's endpoint is public, so an unverified
   * row with an expected event id is anyone's POST, not PayPal's delivery.
   */
  readonly verifiedOnly?: boolean;
};

/**
 * Whether the receiver verifies signatures, read from the row it recorded for
 * our own unsigned self-test POST. A receiver with credentials records that
 * POST as verified=false (it lacks PayPal's headers); one without records
 * verified=null. No row at all proves nothing, so it is not "verifies".
 */
export function receiverVerifies(probe: { readonly verified: boolean | null } | undefined): boolean {
  return probe !== undefined && probe.verified !== null;
}

/** The rows for one event id that count as its arrivals under the same rule as reconcile. */
export function arrivalsOf<T extends { readonly eventId: string | null; readonly verified: boolean | null }>(
  rows: readonly T[],
  eventId: string,
  verifiedOnly: boolean,
): T[] {
  return rows.filter((r) => r.eventId === eventId && (!verifiedOnly || r.verified === true));
}

export function reconcile(
  expected: readonly Expectation[],
  arrivals: readonly Arrival[],
  options: ReconcileOptions = {},
): LedgerReport {
  const notes: string[] = [];
  const verifiedOnly = options.verifiedOnly === true;
  const uncounted = verifiedOnly ? arrivals.filter((a) => a.verified !== true).length : 0;
  arrivals = verifiedOnly ? arrivals.filter((a) => a.verified === true) : arrivals;
  const instanceIds = [...new Set(arrivals.map((a) => a.instanceId))].sort();
  const ledgerVerified = options.ledgerVerified === true;
  // Two independent reasons the ledger may be partial: it spans instances, or it
  // was never proved readable at all. The second is the dangerous one, because
  // zero visible arrivals also means zero visible instance ids, so counting
  // instance ids cannot detect it.
  const degraded = instanceIds.length > 1 || !ledgerVerified;

  const byId = new Map<string, Arrival[]>();
  for (const a of arrivals) {
    const list = byId.get(a.eventId);
    if (list === undefined) byId.set(a.eventId, [a]);
    else list.push(a);
  }

  const matched: Matched[] = [];
  const missing: Expectation[] = [];
  let duplicateCount = 0;

  for (const e of expected) {
    const hits = byId.get(e.eventId);
    if (hits === undefined || hits.length === 0) {
      missing.push(e);
      continue;
    }
    const firstAt = Math.min(...hits.map((h) => h.receivedAtMs));
    const first = hits.find((h) => h.receivedAtMs === firstAt)!;
    duplicateCount += hits.length - 1;
    matched.push({
      eventId: e.eventId,
      eventType: e.eventType,
      latencyMs: firstAt - e.sentAtMs,
      verified: first.verified,
      duplicates: hits.length - 1,
    });
  }

  const expectedIds = new Set(expected.map((e) => e.eventId));
  const unexpected = arrivals.filter((a) => !expectedIds.has(a.eventId));

  if (!ledgerVerified) {
    notes.push(
      "receiver ledger was never proved readable in this run, so a missing event is unproven rather than lost",
    );
  }
  if (instanceIds.length > 1) {
    notes.push(
      `receiver ledger spans ${instanceIds.length} instances (${instanceIds.join(", ")}); a read from one instance cannot see rows written to another`,
    );
  }
  if (duplicateCount > 0) {
    notes.push(`${duplicateCount} redelivery(ies) seen; PayPal retries, so this is expected, not a fault`);
  }
  if (matched.some((m) => m.latencyMs < 0)) {
    notes.push("negative latency: clock skew between the gate host and the receiver");
  }
  if (matched.some((m) => m.verified === false)) {
    notes.push("at least one event failed signature verification");
  }
  if (matched.some((m) => m.verified === null)) {
    notes.push("receiver could not check some signatures (no credentials, a stale transmission time, or a PayPal outage), so verification is unproven for these events");
  }
  if (uncounted > 0) {
    notes.push(
      `${uncounted} unverified arrival(s) not counted: the receiver verifies signatures, so only verified rows are evidence of a PayPal delivery`,
    );
  }
  if (unexpected.length > 0) {
    notes.push(`${unexpected.length} arrival(s) matched no expectation`);
  }

  let verdict: LedgerReport["verdict"];
  if (expected.length === 0) {
    verdict = "fail";
    notes.push("nothing was expected, so nothing was proved");
  } else if (missing.length === 0) {
    verdict = "pass";
  } else if (degraded) {
    verdict = "ambiguous";
  } else {
    verdict = "fail";
  }

  return {
    verdict,
    matched,
    missing,
    unexpected,
    duplicateCount,
    instanceIds,
    degraded,
    notes,
  };
}
