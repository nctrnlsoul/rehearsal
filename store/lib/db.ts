/**
 * Supabase access for the sample store. Same posture as the receiver's ledger:
 * the key travels on the apikey header only, the host is pinned to supabase.co
 * over https, and the key never reaches a log or an error message.
 */

const TABLE = "store_order_events";
const REQUEST_TIMEOUT_MS = 8000;
export const MAX_ROWS = 1000;

const SELECT_COLUMNS =
  "event_id,event_type,capture_id,amount,currency,action,verified,received_at";

export type StoreAction =
  | "fulfilled"
  | "refund_recorded"
  | "dispute_noted"
  | "duplicate_ignored"
  | "ignored";

export type StoreRow = {
  eventId: string | null;
  eventType: string;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
  action: StoreAction;
  verified: boolean | null;
  receivedAtMs: number;
};

export type DbConfig = { readonly url: URL; readonly key: string };

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

export type Db = {
  /** True when any row already records this event id. */
  hasEvent(eventId: string): Promise<boolean>;
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
    receivedAtMs: Number.isNaN(at) ? 0 : at,
  };
}

export function createDb(config: DbConfig, deps: { fetchImpl?: typeof fetch } = {}): Db {
  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = new URL(`/rest/v1/${TABLE}`, config.url);
  // apikey only: the sb_secret_ key format is not a JWT.
  const auth = { apikey: config.key };

  return {
    async hasEvent(eventId) {
      const url = new URL(endpoint);
      url.searchParams.set("select", "id");
      url.searchParams.set("event_id", `eq.${eventId}`);
      url.searchParams.set("limit", "1");
      const res = await doFetch(url, {
        method: "GET",
        headers: auth,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`store event lookup failed with http ${res.status}`);
      const body: unknown = await res.json();
      return Array.isArray(body) && body.length > 0;
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
          },
        ]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`store insert failed with http ${res.status}`);
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
      if (!res.ok) throw new Error(`store read failed with http ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error("store read returned something other than rows");
      return body
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(toRow)
        .reverse();
    },
  };
}
