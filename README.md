# REHEARSAL

A PayPal sandbox scenario engine. Describe a business in plain English and it
builds that business for real in the sandbox: orders, refunds, payouts,
invoices, disputes and webhooks. Ships as a web console and an MCP server.

**Status: day-1 gate only.** No application code exists yet. `gate/` holds
throwaway-grade-honest scripts that prove which PayPal capabilities are
reachable by API before anything is built on them. Results:
[gate/RESULTS.md](gate/RESULTS.md).

## Layout

```
src/core/       pure, no network, no I/O. All the judgement lives here.
src/adapters/   thin. Credentials and HTTP transport, nothing else.
gate/           one script per day-1 gate. Each prints PASS or FAIL with ids.
receiver/       separate tiny Next.js app: the public webhook endpoint for gate 5.
tests/          104 unit tests over src/. None of them open a socket.
```

## Run it

```
npm install
npm test            # 104 tests
npm run typecheck
npm run gate:0      # preflight: must pass before any other gate
npm run gate:1      # ... through gate:6
```

Gates 2 and 6 read state written by earlier gates, so run them in order.

## What is enforced in code, not in a comment

- **Sandbox only.** The host is a literal in `src/core/host.ts`, not a
  configurable base URL. There is no env var that can point this at live PayPal.
  Gate 0 proves the pin refuses live hosts on the machine it runs on.
- **Every write is keyed.** The client throws on a POST, PUT or PATCH with no
  idempotency seed, before it touches the network. Keys are derived from a seed,
  so a retry presents the same `PayPal-Request-Id` and PayPal collapses it.
- **Fail closed.** A 2xx with no status field is `unknown`, never success. 5xx,
  408 and 409 are `unknown` because the write may have executed. Unknown means
  stop and report.
- **Secrets stay out.** Credentials are read in one file, tested for non-empty
  only, and never printed, logged, measured or put in an error. `.env.example`
  carries names only.
- **Outbound events are allowlisted.** An empty allowlist refuses every target
  rather than allowing all of them.
- **Money is integer minor units.** No float touches an amount, and an unknown
  currency is refused rather than assumed to have two decimal places.

## Hackathon

PayPal AI Hackathon, Devpost. Deadline Thu Nov 12 2026, 3:00 PM ET.
