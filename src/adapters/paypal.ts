import {
  DEFAULT_POLICY,
  TRANSPORT_FAILURE,
  retryDecision,
  type RetryPolicy,
} from "../core/backoff";
import { sandboxUrl } from "../core/host";
import { requestId } from "../core/idempotency";
import type { Credentials } from "./env";

/**
 * Thin PayPal transport. It owns exactly four things: the token, the sandbox
 * host pin, the idempotency header, and the retry loop. Every judgement about
 * what a response MEANS belongs to src/core, so this file never decides whether
 * a step succeeded.
 */

const TOKEN_PATH = "/v1/oauth2/token";
/** Methods that create or change a record and therefore require an idempotency key. */
const MUST_BE_IDEMPOTENT = new Set(["POST", "PUT", "PATCH"]);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PREVIEW = 2000;

export type PaypalResponse = {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
  readonly bodyPreview: string;
  readonly debugId: string | null;
  readonly attempts: number;
  readonly transportError: string | null;
  readonly requestIdSent: string | null;
};

/** Non-secret facts about the issued token. Useful for proving which app spoke. */
export type TokenMeta = {
  readonly appId: string | null;
  readonly scopes: string[];
  readonly expiresInSec: number;
};

export type ClientDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly rand?: () => number;
  /** Floor between requests. PayPal publishes no rate limits, so we self-throttle. */
  readonly minIntervalMs?: number;
  readonly policy?: RetryPolicy;
  readonly log?: (line: string) => void;
  readonly label?: string;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PaypalClient {
  readonly #creds: Credentials;
  readonly #deps: ClientDeps;
  #token: { value: string; expiresAtMs: number } | null = null;
  #meta: TokenMeta | null = null;
  #lastRequestAtMs = 0;

  constructor(creds: Credentials, deps: ClientDeps = {}) {
    this.#creds = creds;
    this.#deps = deps;
  }

  get #fetch(): typeof fetch {
    return this.#deps.fetchImpl ?? fetch;
  }

  #nowMs(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #sleepMs(ms: number): Promise<void> {
    return (this.#deps.sleep ?? defaultSleep)(ms);
  }

  #log(line: string): void {
    this.#deps.log?.(`[${this.#deps.label ?? "paypal"}] ${line}`);
  }

  async #throttle(): Promise<void> {
    const floor = this.#deps.minIntervalMs ?? 0;
    if (floor > 0 && this.#lastRequestAtMs !== 0) {
      const gap = this.#nowMs() - this.#lastRequestAtMs;
      if (gap < floor) await this.#sleepMs(floor - gap);
    }
    this.#lastRequestAtMs = this.#nowMs();
  }

  /** Drops the cached token. Called on a 401 so the next call re-authenticates. */
  invalidateToken(): void {
    this.#token = null;
  }

  /** Metadata from the most recent token fetch. Never contains the token itself. */
  get tokenMeta(): TokenMeta | null {
    return this.#meta;
  }

  async accessToken(): Promise<string> {
    const cached = this.#token;
    // Refresh a minute early so a long gate step cannot straddle the expiry.
    if (cached !== null && cached.expiresAtMs - 60_000 > this.#nowMs()) {
      return cached.value;
    }

    const url = sandboxUrl(TOKEN_PATH);
    const basic = Buffer.from(
      `${this.#creds.clientId}:${this.#creds.clientSecret}`,
      "utf8",
    ).toString("base64");

    const res = await this.#fetch(url, {
      method: "POST",
      headers: {
        // Basic auth goes to this endpoint and nowhere else.
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      this.#log(`POST ${TOKEN_PATH} -> ${res.status}`);
      // PayPal's error code only. The body is not echoed: this message reaches
      // step details, run reports and MCP tool output.
      let code = "";
      try {
        const e = (JSON.parse(text) as { error?: unknown }).error;
        if (typeof e === "string" && /^[a-z_]{1,40}$/.test(e)) code = ` (${e})`;
      } catch {
        // Not JSON: the status alone says enough.
      }
      throw new Error(`sandbox token request failed with http ${res.status}${code}`);
    }
    const parsed = JSON.parse(text) as {
      access_token?: unknown;
      expires_in?: unknown;
      app_id?: unknown;
      scope?: unknown;
    };
    if (typeof parsed.access_token !== "string" || parsed.access_token.trim() === "") {
      throw new Error("sandbox token response carried no access_token");
    }
    const expiresInSec = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
    this.#token = {
      value: parsed.access_token,
      expiresAtMs: this.#nowMs() + expiresInSec * 1000,
    };
    this.#meta = {
      appId: typeof parsed.app_id === "string" ? parsed.app_id : null,
      scopes:
        typeof parsed.scope === "string" ? parsed.scope.split(/\s+/).filter((s) => s !== "") : [],
      expiresInSec,
    };
    this.#log(`POST ${TOKEN_PATH} -> 200 token cached for ${expiresInSec}s`);
    return parsed.access_token;
  }

  async call(args: {
    method: string;
    path: string;
    body?: unknown;
    /** Required for POST, PUT and PATCH. Seeds the PayPal-Request-Id. */
    idempotencySeed?: string;
    extraHeaders?: Record<string, string>;
    /**
     * False for a write PayPal may not dedupe by PayPal-Request-Id, such as a
     * webhook resend. A timeout, 408 or 5xx may mean PayPal already acted, so
     * the first such answer is returned instead of replayed. A 429 is still
     * retried: it is a refusal, not an ambiguous outcome.
     */
    replayIfAmbiguous?: boolean;
  }): Promise<PaypalResponse> {
    const method = args.method.toUpperCase();
    const seed = args.idempotencySeed ?? "";

    if (MUST_BE_IDEMPOTENT.has(method) && seed.trim() === "") {
      throw new Error(
        `${method} ${args.path} is a write and must carry an idempotencySeed; refusing to send an unkeyed write`,
      );
    }
    // Throws before any network work if the path could leave the sandbox.
    const url = sandboxUrl(args.path);
    const requestIdSent = seed.trim() === "" ? null : requestId(seed);
    const payload = args.body === undefined ? undefined : JSON.stringify(args.body);

    const policy = this.#deps.policy ?? DEFAULT_POLICY;

    for (let attempt = 1; ; attempt += 1) {
      await this.#throttle();
      const token = await this.accessToken();

      // Sent on every write, body or not. PayPal answers a bodyless POST with
      // 415 UNSUPPORTED_MEDIA_TYPE when the header is absent, and several of
      // its write endpoints take no body at all.
      const sendsJson = payload !== undefined || MUST_BE_IDEMPOTENT.has(method);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(sendsJson ? { "Content-Type": "application/json" } : {}),
        ...(requestIdSent === null ? {} : { "PayPal-Request-Id": requestIdSent }),
        ...(args.extraHeaders ?? {}),
      };

      let status = TRANSPORT_FAILURE;
      let body: unknown = null;
      let bodyPreview = "";
      let debugId: string | null = null;
      let retryAfter: string | null = null;
      let transportError: string | null = null;
      const startedAt = this.#nowMs();

      try {
        const res = await this.#fetch(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = res.status;
        debugId = res.headers.get("paypal-debug-id");
        retryAfter = res.headers.get("retry-after");
        const text = await res.text();
        bodyPreview = text.slice(0, MAX_PREVIEW);
        if (text.trim() !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
        }
      } catch (e) {
        const err = e as Error;
        transportError = `${err.name}: ${err.message}`;
      }

      const elapsed = this.#nowMs() - startedAt;
      this.#log(
        `${method} ${args.path} -> ${transportError ?? status} attempt=${attempt}/${policy.maxAttempts} debug=${debugId ?? "none"} ${elapsed}ms`,
      );

      if (status === 401) {
        // The token is the only credential in play here, so drop it rather than
        // keep presenting one PayPal has rejected.
        this.invalidateToken();
      }

      const decision = retryDecision({
        attempt,
        status,
        retryAfter,
        nowMs: this.#nowMs(),
        ...(this.#deps.rand === undefined ? {} : { rand: this.#deps.rand }),
        policy,
      });

      const ambiguous = status === TRANSPORT_FAILURE || status === 408 || status >= 500;
      if (!decision.retry || (args.replayIfAmbiguous === false && ambiguous)) {
        return {
          method,
          path: args.path,
          status,
          body,
          bodyPreview,
          debugId,
          attempts: attempt,
          transportError,
          requestIdSent,
        };
      }

      this.#log(`retrying in ${decision.delayMs}ms: ${decision.reason}`);
      await this.#sleepMs(decision.delayMs);
    }
  }
}
