import { credentialPresence, credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { type AccountIdentity, assertDistinctAccounts } from "../src/core/accountIdentity";
import { assertSandboxUrl } from "../src/core/host";
import { pick, runGate } from "./_harness";

/**
 * Gate 0 is the precondition for every other gate:
 *  - the credentials must authenticate against the sandbox token endpoint,
 *  - the host pin must be proved to refuse live PayPal on this machine,
 *  - and the two apps must be owned by two DIFFERENT sandbox accounts.
 *
 * The third check was added after both apps turned out to live on one sandbox
 * business account. Every API call succeeded and every gate passed; the fault
 * only appeared at the approval page, because a merchant cannot pay itself.
 * Distinct app ids were never evidence of distinct accounts.
 */

const ROLES = ["seller", "buyer"] as const;

/** Per-ACCOUNT, unlike app_id. Works with a client_credentials token. */
const USERINFO_PATH = "/v1/identity/oauth2/userinfo?schema=paypalv1.1";

const LIVE_HOSTS = [
  "https://api-m.paypal.com/v1/oauth2/token",
  "https://api.paypal.com/v1/oauth2/token",
  "https://api-m.sandbox.paypal.com.evil.test/v1/oauth2/token",
];

/** Capabilities the later gates need, keyed by the scope suffix PayPal returns. */
const CAPABILITIES: Array<{ label: string; suffix: string; neededBy: string; role: string }> = [
  { label: "webhooks", suffix: "applications/webhooks", neededBy: "gate 5", role: "seller" },
  { label: "payouts", suffix: "payments/payouts", neededBy: "gate 3", role: "seller" },
  { label: "refund", suffix: "payments/refund", neededBy: "gate 2", role: "seller" },
  { label: "invoicing", suffix: "services/invoicing", neededBy: "gate 4", role: "seller" },
  { label: "disputes/create", suffix: "disputes/create", neededBy: "gate 6", role: "buyer" },
  { label: "disputes/update-seller", suffix: "disputes/update-seller", neededBy: "gate 6", role: "seller" },
  { label: "disputes/read-buyer", suffix: "disputes/read-buyer", neededBy: "gate 6", role: "buyer" },
];

await runGate({
  id: "0",
  title: "sandbox credentials authenticate, host pin holds, accounts are separate",
  async run(ctx) {
    const presence = credentialPresence();
    for (const p of presence) {
      ctx.log(`${p.present ? "present" : "MISSING"}  ${p.name}`);
    }
    const missing = presence.filter((p) => !p.present).map((p) => p.name);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `these environment variables are missing or blank: ${missing.join(", ")}`,
        qualifier: "BLOCKED",
      };
    }

    // Prove the guard on this machine. A pin that is never exercised is a comment.
    for (const live of LIVE_HOSTS) {
      let refused = false;
      try {
        assertSandboxUrl(live);
      } catch {
        refused = true;
      }
      if (!refused) {
        return {
          ok: false,
          reason: `host pin did NOT refuse ${live}; refusing to run any further gate`,
          qualifier: "UNSAFE",
        };
      }
    }
    ctx.log(`host pin refused all ${LIVE_HOSTS.length} non-sandbox targets`);

    const identities: AccountIdentity[] = [];
    const absent: string[] = [];

    for (const role of ROLES) {
      const client = new PaypalClient(credentialsFor(role), {
        label: role,
        log: ctx.log,
        minIntervalMs: 150,
      });
      await client.accessToken();
      const meta = client.tokenMeta;
      if (meta === null) {
        return { ok: false, reason: `${role} token metadata was not captured`, qualifier: "THREW" };
      }
      ctx.record(`${role}_app_id`, meta.appId ?? "unknown");
      ctx.log(`${role}: ${meta.scopes.length} scopes, token good for ${meta.expiresInSec}s`);

      for (const cap of CAPABILITIES) {
        if (cap.role !== role) continue;
        if (!meta.scopes.some((s) => s.endsWith(cap.suffix))) {
          absent.push(`${role}:${cap.label} (${cap.neededBy})`);
          ctx.note(`${role} app has NO ${cap.label} scope, needed by ${cap.neededBy}`);
        }
      }

      // Which sandbox ACCOUNT owns this app?
      const info = await client.call({ method: "GET", path: USERINFO_PATH });
      const subject = pick(info.body, ["user_id"]) ?? pick(info.body, ["sub"]);
      if (subject === null) {
        ctx.note(`${role}: userinfo returned http ${info.status} with no user_id`);
      }
      identities.push({ role, appId: meta.appId, subject });
    }

    const separation = assertDistinctAccounts(identities);
    for (const [role, fp] of Object.entries(separation.fingerprints)) {
      ctx.record(`${role}_account_fingerprint`, fp);
    }
    ctx.log(`account separation: ${separation.ok ? "ok" : "FAILED"} (${separation.reason})`);

    if (!separation.ok) {
      return {
        ok: false,
        reason: `${separation.reason}. Create a second sandbox BUSINESS account and recreate the buyer app on it, then update PAYPAL_BUYER_CLIENT_ID and PAYPAL_BUYER_CLIENT_SECRET.`,
        qualifier: "UNSAFE",
      };
    }

    if (absent.length > 0) {
      ctx.note(
        "absent scopes are reported, not fatal: PayPal sometimes honours a call whose scope it omits from the token response. The gate that needs it will prove or disprove that.",
      );
    }

    return {
      ok: true,
      reason: `both sandbox apps authenticated on api-m.sandbox.paypal.com, owned by separate accounts; ${absent.length} capability scope(s) absent and noted`,
    };
  },
});
