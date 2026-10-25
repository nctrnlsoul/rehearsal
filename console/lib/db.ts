/**
 * The console's Supabase access (R-040: its own project). Every call is one
 * of the SQL functions in migrations/, never a table read or write, so each
 * rule lives in one place and runs inside one transaction. Same posture as the
 * store: the key travels on the apikey header only, the host is pinned to
 * supabase.co over https, and neither the key nor a response body ever
 * reaches a log or an error message.
 */

const REQUEST_TIMEOUT_MS = 8000;

export const DB_URL_VAR = "SUPABASE_URL";
export const DB_KEY_VAR = "SUPABASE_SERVICE_ROLE_KEY";

/** Every function the console may call. A name not listed here cannot be sent. */
export type RpcName =
  | "console_mark_running"
  | "console_save_state"
  | "console_heartbeat"
  | "console_add_events"
  | "console_finish_run"
  | "console_reap_runs"
  | "console_read_run"
  | "console_active_run"
  | "console_claim_purchase"
  | "console_bank_counts"
  | "console_save_plan"
  | "console_get_plan"
  | "console_take_daily"
  | "console_daily_used"
  | "console_gate_take"
  | "console_gate_fail"
  | "console_gate_clear"
  | "console_start_run";

export type DbConfig = { readonly url: URL; readonly key: string };

/** Carries the function name and upstream status, never the key or a body. */
export class ConsoleDbError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number) {
    super(`console ${operation} failed with http ${status}`);
    this.name = "ConsoleDbError";
    this.operation = operation;
    this.status = status;
  }
}

export function assertSupabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${DB_URL_VAR} is not a parseable absolute URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${DB_URL_VAR} scheme ${url.protocol} is not https:`);
  if (url.username !== "" || url.password !== "") throw new Error(`${DB_URL_VAR} carries userinfo`);
  if (!url.hostname.endsWith(".supabase.co")) throw new Error(`${DB_URL_VAR} host is not a supabase.co host`);
  return url;
}

/** null when storage is not configured; throws when it is configured wrongly. */
export function readDbConfig(env: Record<string, string | undefined>): DbConfig | null {
  const rawUrl = env[DB_URL_VAR];
  const key = env[DB_KEY_VAR];
  const haveUrl = rawUrl !== undefined && rawUrl.trim() !== "";
  const haveKey = key !== undefined && key.trim() !== "";
  if (!haveUrl && !haveKey) return null;
  if (!haveUrl) throw new Error(`${DB_KEY_VAR} is set but ${DB_URL_VAR} is not`);
  if (!haveKey) throw new Error(`${DB_URL_VAR} is set but ${DB_KEY_VAR} is not`);
  return { url: assertSupabaseUrl(rawUrl!.trim()), key: key!.trim() };
}

export type ConsoleDb = {
  /** Calls one SQL function with named arguments and returns PostgREST's JSON answer. */
  rpc(name: RpcName, args: Record<string, unknown>): Promise<unknown>;
};

export function createDb(config: DbConfig, deps: { fetchImpl?: typeof fetch } = {}): ConsoleDb {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async rpc(name, args) {
      const res = await doFetch(new URL(`/rest/v1/rpc/${name}`, config.url), {
        method: "POST",
        // apikey only: the sb_secret_ key format is not a JWT.
        headers: { apikey: config.key, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) throw new ConsoleDbError(name, res.status);
      return (await res.json()) as unknown;
    },
  };
}

/** The database for this request, or null when unconfigured or misconfigured. Callers refuse on null. */
export function dbFromEnv(env: Record<string, string | undefined>, deps: { fetchImpl?: typeof fetch } = {}): ConsoleDb | null {
  let config: DbConfig | null;
  try {
    config = readDbConfig(env);
  } catch (e) {
    // The message names variables, never values.
    console.error(`console db misconfigured: ${(e as Error).message}`);
    return null;
  }
  return config === null ? null : createDb(config, deps);
}
