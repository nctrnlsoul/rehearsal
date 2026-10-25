/**
 * Supabase access for the sample store. Same posture as the receiver's ledger:
 * the key travels on the apikey header only, the host is pinned to supabase.co
 * over https, and the key never reaches a log or an error message.
 */

const TABLE = "store_order_events";
const REQUEST_TIMEOUT_MS = 8000;
export const MAX_ROWS = 1000;

const SELECT_COLUMNS =
  "event_id,event_type,capture_id,amount,currency,action,verified,reason,cert_host,received_at";

export type StoreAction =
  | "fulfilled"
  | "refund_recorded"
  | "dispute_noted"
  | "duplicate_ignored"
  /** Verified, but an event type the shop has no use for. */
  | "ignored"
  /** Not acted on because it could not be trusted or read. `reason` says why. */
  | "refused";

export type StoreRow = {
  eventId: string | null;
  eventType: string;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
  action: StoreAction;
  verified: boolean | null;
  /** Why a delivery was refused. Null for anything that was not. */
  reason: string | null;
  /** Host of the paypal-cert-url header, as sent. Null when absent or unparseable. */
  certHost: string | null;
  receivedAtMs: number;
};

export type DbConfig = { readonly url: URL; readonly key: string };

/**
 * Carries the upstream status, never the key. A bare "it failed" cost several
 * rounds of guessing across two apps, and the status alone names the cause.
 */
export class StoreDbError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number) {
    super(`store ${operation} failed with http ${status}`);
    this.name = "StoreDbError";
    this.operation = operation;
    this.status = status;
  }
}

/** What an upstream status from PostgREST almost always means here. */
export function explainDbStatus(status: number): string {
  if (status === 404) {
    return "the table is missing: SUPABASE_URL may point at a different Supabase project than the one the migration ran in";
  }
  if (status === 401 || status === 403) {
    return "the key was refused: check it is the project's SECRET key (sb_secret_...) and not the publishable key, which anon cannot use against a table with RLS on and grants revoked";
  }
  if (status === 400) return "PostgREST rejected the request shape, so a column may not match the migration";
  return "unexpected upstream status";
}

export function assertSupabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL is not a parseable absolute URL");
  }
  if (url.protocol !== "https:") throw new Error(`SUPABASE_URL scheme ${url.protocol} is not https:`);
  if (url.username !== "" || url.password !== "") throw new Error("SUPABASE_URL carries userinfo");
  if (!url.hostname.endsWith(".supabase.co")) {
    throw new Error(`SUPABASE_URL host ${url.hostname} is not a supabase.co host`);
  }
  return url;
}

/** null when storage is not configured; throws when it is configured wrongly. */
export function readConfig(env: Record<string, string | undefined>): DbConfig | null {
  const rawUrl = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  const haveUrl = rawUrl !== undefined && rawUrl.trim() !== "";
  const haveKey = key !== undefined && key.trim() !== "";
  if (!haveUrl && !haveKey) return null;
  if (!haveUrl) throw new Error("SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is not");
  if (!haveKey) throw new Error("SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not");
  return { url: assertSupabaseUrl(rawUrl!.trim()), key: key!.trim() };
}

export type RowsOptions = {
  readonly limit?: number;
  /** ISO timestamp. Scopes the read to a window rather than a global row cap. */
  readonly sinceIso?: string;
};

/** What a verified event can be recorded as. Refusals and duplicates are never passed in. */
export type VerifiedAction = "fulfilled" | "refund_recorded" | "dispute_noted" | "ignored";

export type VerifiedEvent = {
  eventId: string;
  eventType: string;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
  action: VerifiedAction;
  certHost: string | null;
};

export type Db = {
  /**
   * Records a verified event as `action`, or as duplicate_ignored when a
   * VERIFIED, non-refused row already holds its event id. One database call
   * (store_record_event, migration 0005) that checks and inserts under a lock
   * on the event id, so two deliveries arriving together cannot both act.
   *
   * Refused rows are evidence, not handling: counting them would let a
   * forged copy, or one transient verify failure, mark a real delivery as a
   * duplicate so its retries are ignored and the order is never fulfilled.
   */
  recordOnce(event: VerifiedEvent): Promise<StoreAction>;
  insert(row: Omit<StoreRow, "receivedAtMs">): Promise<void>;
  rows(options?: RowsOptions): Promise<StoreRow[]>;
};

function toRow(raw: Record<string, unknown>): StoreRow {
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const at = typeof raw["received_at"] === "string" ? Date.parse(raw["received_at"]) : Number.NaN;
  return {
    eventId: str(raw["event_id"]),
    eventType: str(raw["event_type"]) ?? "UNKNOWN",
    captureId: str(raw["capture_id"]),
    amount: str(raw["amount"]),
    currency: str(raw["currency"]),
    action: (str(raw["action"]) ?? "ignored") as StoreAction,
    verified: typeof raw["verified"] === "boolean" ? raw["verified"] : null,
    reason: str(raw["reason"]),
    certHost: str(raw["cert_host"]),
    receivedAtMs: Number.isNaN(at) ? 0 : at,
  };
}

export function createDb(config: DbConfig, deps: { fetchImpl?: typeof fetch } = {}): Db {
  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = new URL(`/rest/v1/${TABLE}`, config.url);
  const rpc = new URL("/rest/v1/rpc/store_record_event", config.url);
  // apikey only: the sb_secret_ key format is not a JWT.
  const auth = { apikey: config.key };

  return {
    async recordOnce(event) {
      const res = await doFetch(rpc, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_event_id: event.eventId,
          p_event_type: event.eventType,
          p_capture_id: event.captureId,
          p_amount: event.amount,
          p_currency: event.currency,
          p_action: event.action,
          p_cert_host: event.certHost,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new StoreDbError("record once", res.status);
      const body: unknown = await res.json();
      // Anything but the two answers the function can give means the row's
      // fate is unknown, so it is an error, never a guess.
      if (body === "duplicate_ignored") return "duplicate_ignored";
      if (body === event.action) return event.action;
      throw new Error("store record once returned an unexpected answer");
    },

    async insert(row) {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify([
          {
            event_id: row.eventId,
            event_type: row.eventType,
            capture_id: row.captureId,
            amount: row.amount,
            currency: row.currency,
            action: row.action,
            verified: row.verified,
            reason: row.reason,
            cert_host: row.certHost,
          },
        ]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new StoreDbError("insert", res.status);
    },

    async rows(options: RowsOptions = {}) {
      const url = new URL(endpoint);
      url.searchParams.set("select", SELECT_COLUMNS);
      // Newest first with the cap, so a backlog cannot hide recent rows. The
      // webhook endpoint is publicly writable, so an ascending read plus a limit
      // would let anyone pin the window with junk.
      url.searchParams.set("order", "received_at.desc");
      url.searchParams.set(
        "limit",
        String(Math.min(Math.max(1, options.limit ?? MAX_ROWS), MAX_ROWS)),
      );
      if (options.sinceIso !== undefined) {
        url.searchParams.set("received_at", `gte.${options.sinceIso}`);
      }
      const res = await doFetch(url, {
        method: "GET",
        headers: auth,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new StoreDbError("read", res.status);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error("store read returned something other than rows");
      return body
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(toRow)
        .reverse();
    },
  };
}
