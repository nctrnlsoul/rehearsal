import { createHash } from "node:crypto";

/**
 * Proves two PayPal apps are owned by two different sandbox accounts.
 *
 * Why this exists: two distinct app ids do NOT imply two distinct accounts. Both
 * REHEARSAL apps were originally created under one sandbox business account, so
 * the "buyer" app authenticated as the merchant. Everything API-side looked
 * correct and every gate passed; the mismatch only surfaced at the approval
 * page, where PayPal refused to let the merchant pay itself.
 *
 * The owning account comes from /v1/identity/oauth2/userinfo, whose `user_id`
 * is per-account, not per-app.
 */

export type AccountIdentity = {
  readonly role: string;
  readonly appId: string | null;
  /** Opaque per-account subject URI from userinfo. */
  readonly subject: string | null;
};

export type SeparationVerdict = {
  readonly ok: boolean;
  readonly reason: string;
  /** Short non-reversible digest per role, safe to log and to store in a receipt. */
  readonly fingerprints: Record<string, string>;
};

/** Short digest of an account subject. Proves same-or-different without logging identity. */
export function accountFingerprint(subject: string): string {
  const normalized = subject.trim();
  if (normalized === "") {
    throw new Error("cannot fingerprint a blank account subject");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

export function assertDistinctAccounts(
  identities: readonly AccountIdentity[],
): SeparationVerdict {
  const fingerprints: Record<string, string> = {};

  if (identities.length < 2) {
    return {
      ok: false,
      reason: `need at least two apps to compare, got ${identities.length}`,
      fingerprints,
    };
  }

  // Fail closed on an unreadable owner. Not knowing is not the same as differing.
  const unreadable = identities.filter(
    (i) => i.subject === null || i.subject.trim() === "",
  );
  if (unreadable.length > 0) {
    return {
      ok: false,
      reason: `could not read the owning sandbox account for: ${unreadable
        .map((i) => i.role)
        .join(", ")}; refusing to assume the accounts differ`,
      fingerprints,
    };
  }

  for (const i of identities) {
    fingerprints[i.role] = accountFingerprint(i.subject!);
  }

  for (let a = 0; a < identities.length; a += 1) {
    for (let b = a + 1; b < identities.length; b += 1) {
      const one = identities[a]!;
      const two = identities[b]!;

      if (one.subject!.trim() === two.subject!.trim()) {
        return {
          ok: false,
          reason: `${one.role} and ${two.role} are owned by the SAME sandbox account (fingerprint ${fingerprints[one.role]}); the buyer cannot pay the merchant from the merchant's own account`,
          fingerprints,
        };
      }
      if (one.appId !== null && one.appId === two.appId) {
        return {
          ok: false,
          reason: `${one.role} and ${two.role} are the same app (${one.appId}); each role needs its own app`,
          fingerprints,
        };
      }
    }
  }

  return {
    ok: true,
    reason: `${identities.length} apps, ${identities.length} distinct sandbox accounts`,
    fingerprints,
  };
}
