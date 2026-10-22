/**
 * Fail-closed classification of a PayPal response.
 *
 * The rule this file exists to enforce: a 2xx is evidence that the request was
 * accepted, never that the record reached the state we wanted. Anything we cannot
 * positively recognize is "unknown", and unknown means stop and report.
 */

export type Verdict = {
  readonly kind: "success" | "failed" | "unknown";
  readonly detail: string;
};

/** HTTP statuses where PayPal deterministically refused and nothing was written. */
const TERMINAL_HTTP = new Set([400, 401, 403, 404, 405, 415, 422, 429]);
/** HTTP statuses where the write may or may not have executed. Checked first. */
const AMBIGUOUS_HTTP = new Set([408, 409, 500, 502, 503, 504]);

export function readStatus(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>)["status"];
  return typeof raw === "string" && raw.trim() !== "" ? raw.toUpperCase() : null;
}

export function classify(args: {
  httpStatus: number;
  body: unknown;
  /** Resource statuses that mean the step genuinely completed. */
  expect: readonly string[];
  /** Resource statuses that mean a definite, non-retryable refusal. */
  knownFailed?: readonly string[];
  /** Set only for endpoints documented to return no status field at all. */
  allowNoStatus?: boolean;
}): Verdict {
  const { httpStatus, body } = args;

  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    return { kind: "unknown", detail: `unrecognized http status ${httpStatus}` };
  }
  if (AMBIGUOUS_HTTP.has(httpStatus)) {
    return {
      kind: "unknown",
      detail: `http ${httpStatus}: the write may or may not have executed`,
    };
  }
  if (TERMINAL_HTTP.has(httpStatus) || (httpStatus >= 400 && httpStatus < 500)) {
    return { kind: "failed", detail: `http ${httpStatus}: PayPal refused the request` };
  }
  if (httpStatus >= 500) {
    return { kind: "unknown", detail: `http ${httpStatus}: server error, state unproven` };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { kind: "unknown", detail: `http ${httpStatus} is not a success status` };
  }

  const status = readStatus(body);
  if (status === null) {
    return args.allowNoStatus === true
      ? { kind: "success", detail: `http ${httpStatus}, endpoint returns no status field` }
      : {
          kind: "unknown",
          detail: `http ${httpStatus} but the response carries no status field`,
        };
  }
  if (args.expect.includes(status)) {
    return { kind: "success", detail: `status ${status}` };
  }
  if (args.knownFailed?.includes(status) === true) {
    return { kind: "failed", detail: `status ${status}` };
  }
  return {
    kind: "unknown",
    detail: `status ${status} is neither expected (${args.expect.join(", ") || "none"}) nor a known failure`,
  };
}
