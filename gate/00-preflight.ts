import { credentialPresence, credentialsFor } from "../src/adapters/env";
import { PaypalClient } from "../src/adapters/paypal";
import { assertSandboxUrl } from "../src/core/host";
import { runGate } from "./_harness";

/**
 * Gate 0 is the precondition for every other gate: the credentials must
 * authenticate against the sandbox token endpoint, and the host pin must be
 * proved to refuse live PayPal on this machine rather than assumed to.
 */

const ROLES = ["seller", "buyer"] as const;

const LIVE_HOSTS = [
  "https://api-m.paypal.com/v1/oauth2/token",
  "https://api.paypal.com/v1/oauth2/token",
  "https://api-m.sandbox.paypal.com.evil.test/v1/oauth2/token",
];

/** Capabilities the later gates need, keyed by the scope suffix PayPal returns. */
const CAPABILITIES: Array<{ label: string; suffix: string; neededBy: string }> = [
  { label: "webhooks", suffix: "applications/webhooks", neededBy: "gate 5" },
  { label: "payouts", suffix: "payments/payouts", neededBy: "gate 3" },
  { label: "refund", suffix: "payments/refund", neededBy: "gate 2" },
  { label: "invoicing", suffix: "services/invoicing", neededBy: "gate 4" },
  { label: "disputes/create", suffix: "disputes/create", neededBy: "gate 6" },
  { label: "disputes/update-seller", suffix: "disputes/update-seller", neededBy: "gate 6" },
  { label: "disputes/read-buyer", suffix: "disputes/read-buyer", neededBy: "gate 6" },
];

await runGate({
  id: "0",
  title: "sandbox credentials authenticate and host pinning holds",
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
        const has = meta.scopes.some((s) => s.endsWith(cap.suffix));
        if (!has) {
          absent.push(`${role}:${cap.label} (${cap.neededBy})`);
          ctx.note(`${role} app has NO ${cap.label} scope, needed by ${cap.neededBy}`);
        }
      }
    }

    if (absent.length > 0) {
      ctx.note(
        "absent scopes are reported, not fatal: PayPal sometimes honours a call whose scope it omits from the token response. The gate that needs it will prove or disprove that.",
      );
    }

    return {
      ok: true,
      reason: `both sandbox apps authenticated on api-m.sandbox.paypal.com; ${absent.length} capability scope(s) absent and noted`,
    };
  },
});
