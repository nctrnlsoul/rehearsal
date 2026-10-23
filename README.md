# REHEARSAL

A PayPal sandbox scenario engine. Describe a business in a scenario file and it
builds that business for real in the PayPal sandbox: card orders, refunds,
payouts, invoices, disputes, and real verifiable webhook events.

PayPal's own tools check your code or act on one record at a time. Its Webhook
Simulator sends events that, per PayPal's documentation, cannot be verified,
resent, or looked up, so an app that correctly verifies signatures rejects them.
REHEARSAL creates real records and fires real events that do verify.

**Status: v0.1.0 core.** Scenario schema, executor, step handlers, purchase bank
and CLI. No web console and no MCP server yet. Day-1 capability findings are in
[gate/RESULTS.md](gate/RESULTS.md); the latest demo run is in `runs/`.

## Layout

```
src/core/        pure, no network, no I/O. All the judgement lives here.
src/adapters/    thin. Credentials, HTTP transport, JSON file storage.
src/executor/    scenario execution: handlers, runner, dry run, report.
bin/rehearsal.ts the command line. Thin glue over tested modules.
scenarios/       scenario files. candle-shop.json uses every step kind.
gate/            the day-1 capability gates that proved each API path.
receiver/        separate tiny Next.js app: the public webhook endpoint.
tests/           275 unit tests over src/. None of them opens a socket.
```

## Use it

```
npm install
npm test                 # 275 tests
npm run typecheck

npm run dry-run scenarios/candle-shop.json      # prints the plan, zero network calls
npm run rehearsal -- run scenarios/candle-shop.json
npm run rehearsal -- run scenarios/candle-shop.json --resume <runId> [--retry <stepId>]
```

Run state lands in `runs/<runId>.json` and a readable report in
`runs/<runId>.md`. Both are local only.

### Disputes need a banked purchase

A PayPal-wallet payment cannot be approved server to server, and the buyer-side
transaction id a dispute needs is not visible anywhere on the seller side. So
purchases are banked ahead of time, one human click each:

```
npm run bank:add -- --amount 54.00    # creates an order, prints the approval link
# approve the link as the sandbox BUYER business account
npm run bank:confirm                  # captures it, then finds the buyer transaction id
npm run bank:list
```

`bank:confirm` is safe to re-run. PayPal documents Transaction Search as lagging
up to three hours, so a purchase that is not visible yet stays pending and says
so rather than being silently dropped.

## Scenario files

A scenario is a business profile plus typed steps with ids, dependencies and
decimal-string amounts. Step kinds: `card_order`, `refund`, `payout_batch`,
`invoice_create`, `invoice_send`, `invoice_record_payment`, `invoice_cancel`,
`open_dispute`.

Nothing runs unless the file passes the schema, which rejects unknown step
kinds, numeric amounts, amounts with more decimal places than the currency
allows, unknown currencies, dangling and cyclic dependencies, more than 60
steps, and any event target not on the allowlist.

## What is enforced in code, not in a comment

- **Sandbox only.** The host is a literal in `src/core/host.ts`, not a
  configurable base URL, so no env var can point this at live PayPal. Gate 0
  proves the pin refuses live hosts on the machine it runs on.
- **Two different sandbox accounts.** Distinct app ids are not evidence of
  distinct accounts, which is how both apps once ended up on one business
  account with every gate still green. Gate 0 now compares the owning account.
- **Every write is keyed.** The client throws on a POST, PUT or PATCH with no
  idempotency seed, before it touches the network. Seeds derive from run id plus
  step id, so a retry presents the same key and PayPal collapses it.
- **Fail closed.** A 2xx with no status field is `unknown`, never success. 5xx,
  408 and 409 are `unknown` because the write may have executed. Anything other
  than success halts the run, and a halted step is never retried without an
  explicit human `--retry`.
- **A failed read is never an empty result.** A non-200 from PayPal's event list
  is reported as unreadable, not as "no events".
- **Measure the instrument first.** Gate 5 posts a self-test event and refuses
  to proceed unless it can read it back, because an unreadable ledger looks
  exactly like lost events.
- **Secrets stay out.** Credentials are read in one file, tested for non-empty
  only, and never printed, logged, measured or put in an error.
- **Money is integer minor units.** No float touches an amount, and an unknown
  currency is refused rather than assumed to have two decimal places.

## Hackathon

PayPal AI Hackathon, Devpost. Deadline Thu Nov 12 2026, 3:00 PM ET.
