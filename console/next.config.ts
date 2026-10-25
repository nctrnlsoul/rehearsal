import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Security headers at the platform layer, so no route can ship without them.
 * The Content-Security-Policy is set per request in middleware.ts, because it
 * carries a fresh nonce; everything else is fixed and lives here.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Not no-referrer: under it a browser sends "Origin: null" on the gate's own
  // form POST, and the gate refuses any request it cannot place as same-origin.
  // same-origin still sends nothing to other sites.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const config: NextConfig = {
  poweredByHeader: false,
  // Pinned so file tracing cannot latch onto a stray lockfile higher up the tree.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
