# REHEARSAL

A PayPal sandbox scenario engine for developers building on PayPal. Describe a business in plain English or a
scenario file and it builds that business for real in the PayPal sandbox: card
orders, refunds, payouts, invoices, disputes, and real webhook events that
verify. Then its edge-case finder checks how a merchant app handled them.

A scenario run from the CLI or the MCP server fires at your own app: allow
your app's https origin in `REHEARSAL_EVENT_ORIGINS`, point the scenario's
`webhook.target` at `https://<your-app>/api/paypal/webhook` (the one handler
path it accepts), and the run registers that webhook on your sandbox seller
app, so PayPal itself delivers real, verifiable sandbox events to your handler.
The hosted console fires only at the sample store, for safety.

## Judges start here

- **Hosted console:** https://rehearsal-indol.vercel.app. Recorded replays of
  real runs are open to everyone. Live runs are behind a passcode.
- **Passcode:** in the private Devpost testing notes. It unlocks live runs for
  2 hours in that browser.
- **Video (2:16):** https://www.youtube.com/watch?v=ehJ-sJr2lAY
- **Evidence:** [evidence/](evidence/) holds the finder's reports and the run
  state from real sandbox runs, including the finder run that reproduces the
  classic duplicate-delivery bug with PayPal's real redelivery, then proves the
  one-line fix.
- **Offline, no keys needed** (Node 22 or later):

  ```
  npm install
  npm test
  npm run dry-run scenarios/quick-start.json
  ```

  The dry run validates the scenario, checks it against the spend caps and
  prints the plan. It makes no network call.

**Status: v0.7.6.** Scenario schema, executor, step handlers, purchase bank,
CLI, AI planner, edge-case finder, a stdio MCP server for Claude Code, and a
web console with live sandbox runs behind the judge passcode. Day-1 capability
findings are in [gate/RESULTS.md](gate/RESULTS.md).

## Why

PayPal's
[Webhook Simulator](https://developer.paypal.com/api/rest/webhooks/simulator/)
sends mock events that, per PayPal's documentation, cannot be verified through
the verify-webhook-signature endpoint, cannot be resent, and match no real
transaction. So an app that verifies through that endpoint rejects them.
REHEARSAL creates real records and fires real events that do verify.

## How it uses PayPal and AI

**PayPal, sandbox only** (`api-m.sandbox.paypal.com`, pinned in code):

| PayPal API | What REHEARSAL does with it |
|---|---|
| Orders v2 (`/v2/checkout/orders`) | Card payments captured in one call (intent `CAPTURE` with `payment_source.card`, no buyer step); wallet orders for the purchase bank |
| Payments v2 (`/v2/payments/captures/{id}/refund`) | Full and partial refunds |
| Invoicing v2 (`/v2/invoicing/invoices`) | Create, send (with no email to anyone), record a payment, cancel |
| Payouts v1 (`/v1/payments/payouts`) | Payout batches, including items left unclaimed (CLI and MCP) |
| Disputes v1 (`/v1/customer/disputes`) | Opens a dispute on a banked purchase (PayPal's sandbox-only create), then reads PayPal's record back to check it names the banked capture |
| Webhooks v1 (`/v1/notifications/...`) | Registers and looks up webhooks, verifies every delivery through `verify-webhook-signature`, lists events, and asks PayPal to resend one for the duplicate-delivery test |
| Transaction Search v1 (`/v1/reporting/transactions`) | Finds the buyer-side transaction a dispute needs |
| OAuth 2.0 and Identity | Client-credentials tokens; proves the buyer and seller are different sandbox accounts |

**AI: Claude Sonnet 5 (`claude-sonnet-5`) through the Anthropic API**, called with
the Vercel AI SDK (`ai`, `@ai-sdk/anthropic`). The model name is the default in
`src/ai/planner.ts`; `REHEARSAL_PLANNER_MODEL` can change it.

- **AI planner:** turns a plain-English business description into a scenario.
  Every reply is re-checked against the schema, the spend caps and the
  event-target allowlist before it can run. At most 4,000 output tokens and 60
  seconds per call.
- **AI finder:** for each bug class the model fills a fixed template (values
  only, never steps). The verdict never comes from the model: it comes from the
  sample store's verified records or PayPal's own read-back.
- **MCP server:** an AI coding assistant such as Claude Code can plan, dry run
  and run scenarios, with an explicit `confirm` before anything writes.

**Other tools:** TypeScript on Node 22, Next.js 15 and React (console, sample
store, receiver), Supabase Postgres, Vercel hosting and its WAF rate limits,
zod, the MCP TypeScript SDK, Vitest, Playwright and PGlite for tests, and the
fonts Instrument Sans and JetBrains Mono (OFL). No sponsor tools are used.

**Built with AI assistance:** Claude Code (implementation and tests) and Claude
(planning, audits and review), both running Claude Opus 5.5, with Claude Opus 5
for the first two days (the commit trailers name the model on each commit), and
Claude Design (the console's visual direction). The product itself calls Claude
Sonnet 5, as above.

## Layout

```
src/core/        pure, no network, no I/O. All the judgment lives here.
src/adapters/    thin. Credentials, HTTP transport, JSON file storage.
src/executor/    scenario execution: handlers, runner, dry run, report.
src/ai/          planner (plain English to scenario) and the edge-case finder.
src/app/         wiring shared by the CLI and the MCP server.
src/mcp/         the MCP server: six tools and the output guard.
bin/rehearsal.ts the command line. Thin glue over tested modules.
bin/mcp.ts       the MCP server's stdio entry point.
scenarios/       scenario files. quick-start.json runs anywhere; candle-shop.json uses every step kind.
gate/            the day-1 capability gates that proved each API path.
receiver/        separate tiny Next.js app: the public webhook endpoint.
store/           the sample merchant app the edge-case finder tests (setup: store/README.md).
console/         the web console (Next.js): replays, the judge gate, live runs.
evidence/        finder reports and run state from real sandbox runs.
tests/           unit tests over src/. None of them opens a socket.
```

## Run it yourself, from zero

The hosted console needs nothing installed. To run it all on your own machine,
go in this order; each step works without the ones after it.

1. **Offline, no accounts.** Node 22 or later, then `npm install`, `npm test`
   and `npm run dry-run scenarios/quick-start.json`. Nothing touches the network.
2. **PayPal sandbox.** In the
   [PayPal developer dashboard](https://developer.paypal.com/dashboard/), use two
   sandbox business accounts and create one REST app on each: a seller app, which
   runs every step, and a buyer app, which files disputes. Set the four variables
   named in [.env.example](.env.example) in your OS environment, never in a file.
   Then run `npm run gate:0`: it checks both apps authenticate against the sandbox
   and lists any capability the later steps need that an app's token lacks. Turn
   the missing ones on in that app's settings in the dashboard. This project had
   to turn on Invoicing for the seller app, and Transaction Search for the buyer
   app, which disputes use.
3. **First live run.** `npm run rehearsal -- run scenarios/quick-start.json`
   creates a card order, a partial refund and an overdue invoice in your sandbox.
4. **The AI planner.** Add `ANTHROPIC_API_KEY`, run
   `npm run rehearsal -- plan "a candle shop that invoices wholesale buyers" --out plan.json`,
   read `plan.json`, then `npm run rehearsal -- run plan.json`.
5. **Webhooks to your own app.** Allow your app's https origin in
   `REHEARSAL_EVENT_ORIGINS` and point a scenario's `webhook.target` at
   `https://<your-app>/api/paypal/webhook`. The run registers that webhook on your
   sandbox seller app, so PayPal delivers real, verifiable events to your handler.
6. **The sample store and the finder.** Set up the store with
   [store/README.md](store/README.md), set `REHEARSAL_STORE_ORIGIN` and
   `REHEARSAL_STORE_TOKEN`, then run `npm run find`.
7. **Disputes.** Bank a buyer-approved purchase first:
   [Disputes need a banked purchase](#disputes-need-a-banked-purchase).
8. **Claude Code.** Register the MCP server: [Use with Claude Code](#use-with-claude-code).
9. **The web console.** It has its own Supabase and Vercel projects:
   [Web console](#web-console-console) and [console/.env.example](console/.env.example).

## Use it

```
npm install
npm test
npm run typecheck

npm run dry-run scenarios/quick-start.json      # prints the plan, zero network calls
npm run rehearsal -- run scenarios/quick-start.json
npm run rehearsal -- run scenarios/quick-start.json --resume <runId> [--retry <stepId>]

npm run rehearsal -- plan "a candle shop that invoices wholesale buyers" [--out <file>]
npm run find -- [--only duplicate-webhook]      # the edge-case finder against the sample store
```

Running needs sandbox keys in your environment (names in
[.env.example](.env.example)). `plan` and `find` also need `ANTHROPIC_API_KEY`;
`find` needs the sample store's origin and token.

`plan` saves the plan to a file and runs nothing; you read it, then run that
exact file. Planning is not deterministic, so running the saved file is the
only way to run what you reviewed. `plan --yes` runs the plan it just printed,
in the same invocation.

`candle-shop.json` declares a webhook at the sample receiver, so it runs only
when that origin is allowed: set `REHEARSAL_RECEIVER_ORIGIN` or
`REHEARSAL_EVENT_ORIGINS`. Every event target must be on that allowlist.

Run state lands in `runs/<runId>.json` and a readable report in
`runs/<runId>.md`. Both are local only.

### Disputes need a banked purchase

A PayPal-wallet payment cannot be approved server to server, and the buyer-side
transaction id a dispute needs is not in the seller's order or capture records. So
purchases are banked ahead of time, one human click each:

```
npm run bank:add -- --amount 54.00    # creates an order, prints the approval link
# approve the link as the sandbox BUYER business account
npm run bank:confirm                  # captures it, then finds the buyer transaction id
npm run bank:list
npm run bank:export-hosted -- --count 1   # moves ready purchases to the console's bank, as SQL
```

On Windows, PowerShell drops a bare `--`, so npm silently ignores the flags after it (`--amount 54.00` falls back to the default 88.00). Run these in cmd, or quote it in PowerShell: `npm run bank:add '--' --amount 54.00`.

`bank:add` applies the per-step cap before any order exists. `bank:confirm` is
safe to re-run. It matches the buyer transaction by amount, currency and the
time closest to the order. An order PayPal no longer holds (404 on the order)
is marked `expired` rather than checked forever, so approve a link promptly
after creating it.

Finding the buyer-side transaction id needs PayPal's
[Transaction Search API](https://developer.paypal.com/docs/api/transaction-search/v1/)
and a reporting scope on the buyer app, and a new transaction may not be listed there yet.
When it is unavailable, read the id from the sandbox buyer account's activity
page and supply it:

```
npm run bank:set-txn -- --order <orderId> --txn <buyerTransactionId>
```

`bank:export-hosted` writes a SQL file for the console database's SQL editor
and marks those purchases used locally first, so one purchase is never in both
banks. It reads no keys and makes no network call.

## Use with Claude Code

REHEARSAL runs as a local MCP server over stdio. There is no HTTP transport and
nothing listens on a port. Claude Code starts it as a child process, and it
inherits Claude Code's environment, so the keys stay in your OS environment
variables and never go in a config file.

Register it once (use your own path to the repo):

```
claude mcp add rehearsal --scope user -- node /path/to/rehearsal/node_modules/tsx/dist/cli.mjs /path/to/rehearsal/bin/mcp.ts
```

No `-e` flags and no `env` block: the server reads the same variables the CLI
does, by name, from the environment Claude Code was started in.

| Variable | Needed by |
|---|---|
| `PAYPAL_SELLER_CLIENT_ID`, `PAYPAL_SELLER_CLIENT_SECRET` | `run_scenario`, `find_edge_cases` |
| `PAYPAL_BUYER_CLIENT_ID`, `PAYPAL_BUYER_CLIENT_SECRET` | `run_scenario`, `find_edge_cases` |
| `ANTHROPIC_API_KEY` | `plan_scenario`, `find_edge_cases` |
| `REHEARSAL_STORE_ORIGIN`, `REHEARSAL_STORE_TOKEN` | `find_edge_cases` |
| `REHEARSAL_RECEIVER_ORIGIN`, `REHEARSAL_EVENT_ORIGINS` | optional, more allowed event targets |

The tools:

| Tool | What it does | Writes to the sandbox |
|---|---|---|
| `plan_scenario` | plain English in, validated scenario out (one model call) | no |
| `dry_run` | schema, caps, event-target allowlist and purchase bank check, plus the plan | no |
| `run_scenario` | executes, only with `confirm: true`; otherwise returns the dry run | yes |
| `run_status` | progress and step outcomes for a run id | no |
| `bank_status` | how many banked purchases a dispute can use (counts, no ids) | no |
| `find_edge_cases` | the edge-case finder against the sample store, only with `confirm: true` | yes |

Try: *"Plan an open dispute waiting for my response."* The plan is one
`open_dispute` step that draws a banked purchase. If the bank has none, every
tool says `needs a banked purchase: run bank:add` instead of guessing.

What the server holds to, in code:

- The scenario schema, spend caps, event-target allowlist, sandbox host pin,
  idempotency keys and resumable run state, through the same modules the CLI
  uses. The caps are checked on every path that can run, MCP or CLI, before
  any PayPal call.
- A resume, from MCP or the CLI, must present the exact scenario the run
  started from (its SHA-256 is recorded in the run state), so a changed
  scenario cannot finish a run. Runs from before v0.4.0 have no digest and
  cannot be resumed.
- A step that started and never recorded an outcome (the process died
  mid-call) is unknown on resume and halts the run: it may have reached PayPal.
- Nothing writes to PayPal without `confirm: true`. Leave `run_scenario` and
  `find_edge_cases` on "ask" in Claude Code's permissions, so you approve each
  call and see its arguments.
- A halted run is not retried over MCP. Retrying a step that may already have
  written is a CLI action, after you check: `--resume <runId> --retry <stepId>`.
- One execution at a time, and per-session ceilings: 20 model calls
  (`REHEARSAL_MCP_MAX_MODEL_CALLS`) and 10 executing tool calls
  (`REHEARSAL_MCP_MAX_RUNS`; one `find_edge_cases` call counts once but can run
  up to four scenarios). Restart the server to reset them.
- Every input is size-capped. Every output has control characters stripped,
  error text is generic, and no environment value is ever returned.
- The finder reuses the store's registered webhook and never registers one.

### Alongside PayPal's Agent Toolkit

PayPal's [Agent Toolkit](https://github.com/paypal/agent-toolkit) acts on one
record at a time: get an order, list disputes, accept a claim, send an invoice
reminder. Its published tool list has no tool to open a dispute, send a payout
or redeliver a webhook, so on its own it has little realistic state to act on.
REHEARSAL builds that state. Run both in the same Claude Code session, both
pointed at the sandbox:

1. REHEARSAL `plan_scenario` and `run_scenario` build the situation: a dispute
   waiting on the merchant, an overdue invoice, an unclaimed payout, a refunded
   capture.
2. The toolkit's tools work it: `list_disputes`, `get_dispute`,
   `accept_dispute_claim`, `send_invoice_reminder`, `list_transactions`.
3. REHEARSAL `find_edge_cases` checks how your own app handled the events.

## Web console (`console/`)

Five surfaces: the trust panel (`/`), the scenario builder (`/build`), run
replays (`/runs/<id>`), the edge-case finder (`/finder`) and the judge gate
(`/gate`). Without the passcode they show recorded replays of real runs, and
every page that shows recorded data says REPLAY.

Behind the passcode, `/live` plans a business with the AI planner (or takes a
recorded plan), shows the same dry run the CLI prints, and runs it against the
sandbox. `/live/<runId>` follows the run as it happens: each call PayPal
accepted, each webhook delivery the sample store received, joined where the
pairing is exact, with the measured delay. The hosted finder runs one failure
class per request against the sample store.

**Hosted limits, fixed in code** (an environment variable can lower each money,
step and count limit, never raise it; the run time budget and one run at a time
are fixed):

| Limit | Value |
|---|---|
| Per step / per run | USD 150 / USD 400 |
| Steps / disputes per run | 8 / 1 |
| Worst-case run time | 600 s; a step is not started unless it can finish |
| Live runs a day | 20 in all, 5 per session |
| Planner calls a day | 30 in all, 8 per session |
| Runs at once | 1 |

**Kill switch:** live runs happen only while `CONSOLE_LIVE_RUNS` is exactly
`on`. Anything else, unset included, pauses them; replays keep working.

**Judge gate:**
- The passcode is compared server-side, as an scrypt hash, with `timingSafeEqual`.
- Wrong tries are counted per client address (`x-vercel-forwarded-for` only,
  which Vercel sets and does not take from the client; IPv6 counted by /64):
  30 wrong tries lock that address for an hour. The count lives in the
  console's own database, so every server instance shares it. If that database
  does not answer, the gate stays shut.
- A global count of wrong tries is logged when it crosses its ceiling but
  refuses no one, so the right passcode always works from an address that is
  not locked. Guessing from many addresses is bounded by a Vercel WAF rate
  limit on `POST /api/gate`, set in the Vercel dashboard, not in this repo.
- A passing passcode gets a signed `__Host-` session cookie: httpOnly, Secure,
  SameSite=Strict, 2 hours.
- Every POST checks the kill switch, the session, that Origin equals Host, the
  content type, a streamed byte cap and an exact list of keys.

```
cd console
npm install
npm test                          # unit tests, including the SQL against a real Postgres (PGlite)
npm run build                     # the browser tests serve this production build
npx playwright install chromium   # the browser the tests drive, once per machine
npm run test:browser              # browser tests (Playwright)
```

`npm run dev` serves the console at http://localhost:3000 while you work on it.

Every variable, required or optional, is listed in
[console/.env.example](console/.env.example). Set them for Production only.
The console uses its own Supabase project; apply `console/migrations` first.

**Fonts:** Instrument Sans and JetBrains Mono, both OFL, are committed with their
licenses under `console/app/fonts/` and served by the console itself. The build
fetches nothing.

## Scenario files

A scenario is a business profile plus typed steps with ids, dependencies and
decimal-string amounts. Step kinds: `card_order`, `refund`, `payout_batch`,
`invoice_create`, `invoice_send`, `invoice_record_payment`, `invoice_cancel`,
`open_dispute`, `resend_webhook`.

Nothing runs unless the file passes the schema, which rejects unknown step
kinds, numeric amounts, amounts with more decimal places than the currency
allows, unknown currencies, dangling and cyclic dependencies, more than 60
steps, and any event target not on the allowlist.

## What is enforced in code, not in a comment

- **Sandbox only.** The host is a literal in `src/core/host.ts`, not a
  configurable base URL, so no env var can point this at live PayPal, and every
  PayPal request refuses redirects. Gate 0 proves the pin refuses live hosts on
  the machine it runs on.
- **Two different sandbox accounts.** Distinct app ids are not evidence of
  distinct accounts, which is how both apps once ended up on one business
  account with every gate still green. Gate 0 now compares the owning account.
- **Every write is keyed and capped.** The client throws on a POST, PUT or
  PATCH with no idempotency seed, before it touches the network. Seeds derive
  from run id plus step id, so a retry presents the same key and PayPal
  collapses it. Caps are checked in integer minor units before any client
  exists; a payout batch counts all its items against the per-step cap.
- **Fail closed.** A 2xx with no status field is `unknown`, never success. 5xx,
  408 and 409 are `unknown` because the write may have executed, and a write
  PayPal may not dedupe (invoice create, send, record payment and cancel, and
  webhook resend) is never replayed after one. Anything other than success halts the run, and
  a halted step is never retried without an explicit human `--retry`.
- **No verdict without evidence.** The finder says BUG or OK only when the step
  under test ran and its outcome is on record: the store's own verified rows for
  a webhook class, PayPal's own read-back of the item or invoice for the payout
  and invoice classes. Anything else is INCONCLUSIVE, with the reason.
- **A failed read is never an empty result.** A non-200 from PayPal's event list
  is reported as unreadable, not as "no events".
- **Measure the instrument first.** Gate 5 posts a self-test event and refuses
  to proceed unless it can read it back, because an unreadable ledger looks
  exactly like lost events.
- **Secrets stay out.** Credentials are read in one file in the engine, tested
  for non-empty only, and never printed, logged, measured or put in an error.
  The CLI stops on a missing one with a single line naming the variable and
  exit code 2. PayPal error text is reduced to PayPal's named error fields; a
  raw reply body is never quoted.
- **Money is integer minor units.** No float touches an amount, and an unknown
  currency is refused rather than assumed to have two decimal places.

## License

MIT. See [LICENSE](LICENSE).

## Hackathon

PayPal AI Hackathon, Devpost. Deadline Thu Nov 12 2026, 12:00 PM PT.
