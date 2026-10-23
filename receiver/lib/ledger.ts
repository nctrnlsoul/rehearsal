import { randomUUID } from "node:crypto";

/**
 * Durable arrival ledger, backed by one Supabase table.
 *
 * Replaces an in-memory array that could not work on Vercel: writes and reads
 * land on different serverless instances, so arrivals were recorded into memory
 * nothing could read.
 *
 * The service role key is read from the environment at request time and only
 * ever travels in request headers to a pinned supabase.co host. It is never
 * logged, never interpolated into an error, and never sent to the browser.
 */

export const INSTANCE_ID = randomUUID().slice(0, 8);
export const BOOTED_AT_MS = Date.now();

const TABLE = "webhook_arrivals";
const REQUEST_TIMEOUT_MS = 8000;
export const MAX_ROWS = 500;

const SELECT_COLUMNS =
  "event_id,event_type,received_at,verified,verify_detail,resource_id,transmission_id,instance_id";

export type Row = {
  eventId: string | null;
  eventType: string | null;
  receivedAtMs: number;
  /** null when the receiver held no credentials and did not attempt verification. */
  verified: boolean | null;
  verifyDetail: string;
  resourceId: string | null;
  transmissionId: string | null;
  instanceId: string;
};

export type LedgerConfig = {
  readonly url: URL;
  readonly key: string;
};

/**
 * Pins the storage host. A SUPABASE_URL that could be anything is an
 * exfiltration path for every webhook we record, so it is validated at the
 * trust boundary rather than trusted because it came from an env var.
 */
export function assertSupabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL is not a parseable absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error(`SUPABASE_URL scheme ${url.protocol} is not https:`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("SUPABASE_URL carries userinfo");
  }
  if (!url.hostname.endsWith(".supabase.co")) {
    throw new Error(`SUPABASE_URL host ${url.hostname} is not a supabase.co host`);
  }
  return url;
}

/**
 * Returns null when storage is simply not configured, and THROWS when it is
 * configured wrongly. Those are different situations and must not collapse into
 * one silent outcome.
 */
export function readConfig(env: Record<string, string | undefined>): LedgerConfig | null {
  const rawUrl = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  const haveUrl = rawUrl !== undefined && rawUrl.trim() !== "";
  const haveKey = key !== undefined && key.trim() !== "";

  if (!haveUrl && !haveKey) return null;
  if (!haveUrl) throw new Error("SUPABASE_SERVICE_ROLE_KEY is set but SUPABASE_URL is not");
  if (!haveKey) throw new Error("SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not");

  return { url: assertSupabaseUrl(rawUrl!.trim()), key: key!.trim() };
}

export type Ledger = {
  append(row: Omit<Row, "instanceId">): Promise<void>;
  snapshot(limit?: number): Promise<Row[]>;
};

function toRow(raw: Record<string, unknown>): Row {
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const at = typeof raw["received_at"] === "string" ? Date.parse(raw["received_at"]) : Number.NaN;
  return {
    eventId: str(raw["event_id"]),
    eventType: str(raw["event_type"]),
    receivedAtMs: Number.isNaN(at) ? 0 : at,
    verified: typeof raw["verified"] === "boolean" ? raw["verified"] : null,
    verifyDetail: str(raw["verify_detail"]) ?? "",
    resourceId: str(raw["resource_id"]),
    transmissionId: str(raw["transmission_id"]),
    instanceId: str(raw["instance_id"]) ?? "unknown",
  };
}

export function createLedger(
  config: LedgerConfig,
  deps: { fetchImpl?: typeof fetch } = {},
): Ledger {
  const doFetch = deps.fetchImpl ?? fetch;
  const endpoint = new URL(`/rest/v1/${TABLE}`, config.url);
  const auth = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
  };

  return {
    async append(row) {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify([
          {
            event_id: row.eventId,
            event_type: row.eventType,
            received_at: new Date(row.receivedAtMs).toISOString(),
            verified: row.verified,
            verify_detail: row.verifyDetail,
            resource_id: row.resourceId,
            transmission_id: row.transmissionId,
            instance_id: INSTANCE_ID,
          },
        ]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Status only. The key lives in the headers and must not reach a message.
        throw new Error(`ledger insert failed with http ${res.status}`);
      }
    },

    async snapshot(limit = MAX_ROWS) {
      const url = new URL(endpoint);
      url.searchParams.set("select", SELECT_COLUMNS);
      url.searchParams.set("order", "received_at.asc");
      url.searchParams.set("limit", String(Math.min(Math.max(1, limit), MAX_ROWS)));

      const res = await doFetch(url, {
        method: "GET",
        headers: auth,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`ledger read failed with http ${res.status}`);
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        throw new Error("ledger read returned something other than a row array");
      }
      return body
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map(toRow);
    },
  };
}
