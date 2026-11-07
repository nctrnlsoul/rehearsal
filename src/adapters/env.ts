/**
 * The only place credentials are read. Values are never logged, returned in an
 * error, or interpolated into a message: callers get the variable NAME back.
 */

export type AppRole = "seller" | "buyer";

export type Credentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export const CREDENTIAL_VARS: Record<AppRole, { id: string; secret: string }> = {
  seller: { id: "PAYPAL_SELLER_CLIENT_ID", secret: "PAYPAL_SELLER_CLIENT_SECRET" },
  buyer: { id: "PAYPAL_BUYER_CLIENT_ID", secret: "PAYPAL_BUYER_CLIENT_SECRET" },
};

export class MissingCredentialError extends Error {
  readonly variableName: string;

  constructor(variableName: string) {
    super(`environment variable ${variableName} is missing or blank`);
    this.name = "MissingCredentialError";
    this.variableName = variableName;
  }
}

type Env = Record<string, string | undefined>;

/** Non-empty test only. Never compares, prints or measures the value. */
export function requiredEnv(name: string, env: Env = process.env): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new MissingCredentialError(name);
  }
  return raw;
}

export function optionalEnv(name: string, env: Env = process.env): string | null {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? null : raw;
}

export function credentialsFor(role: AppRole, env: Env = process.env): Credentials {
  const vars = CREDENTIAL_VARS[role];
  // Whitespace is never part of a client id or secret; a pasted newline would
  // otherwise turn into an invalid_client from PayPal.
  return {
    clientId: requiredEnv(vars.id, env).trim(),
    clientSecret: requiredEnv(vars.secret, env).trim(),
  };
}

/** Presence report for the preflight gate. Booleans only, by design. */
export function credentialPresence(env: Env = process.env): Array<{ name: string; present: boolean }> {
  return Object.values(CREDENTIAL_VARS)
    .flatMap((v) => [v.id, v.secret])
    .map((name) => ({ name, present: optionalEnv(name, env) !== null }));
}
