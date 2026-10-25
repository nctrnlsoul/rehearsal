# REHEARSAL

A PayPal sandbox scenario engine. Describe a business in a scenario file and it
builds that business for real in the PayPal sandbox: card orders, refunds,
payouts, invoices, disputes, and real verifiable webhook events.

PayPal's own tools check your code or act on one record at a time. Its Webhook
Simulator sends events that, per PayPal's documentation, cannot be verified,
resent, or looked up, so an app that correctly verifies signatures rejects them.
REHEARSAL creates real records and fires real events that do verify.

**Status: v0.4.0.** Scenario schema, executor, step handlers, purchase bank,
CLI, AI planner, edge-case finder, and a stdio MCP server for Claude Code. No web
console yet. Day-1 capability findings are in [gate/RESULTS.md](gate/RESULTS.md).

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
scenarios/       scenario files. candle-shop.json uses every step kind.
gate/            the day-1 capability gates that proved each API path.
receiver/        separate tiny Next.js app: the public webhook endpoint.
store/           the sample merchant app the edge-case finder tests.
console/         the web console (Next.js). Stage A: recorded replays and the judge gate.
tests/           unit tests over src/. None of them opens a socket.
```

## Use it

```
npm install
npm test
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

`bank:confirm` is safe to re-run. An order PayPal no longer holds (404 on the
order) is marked `expired` rather than checked forever, so approve a link
promptly after creating it.

Finding the buyer-side transaction id needs a reporting scope on the buyer app,
and PayPal documents Transaction Search as lagging up to three hours even then.
When it is unavailable, read the id from the sandbox buyer account's activity
page and supply it:

```
npm run bank:set-txn -- --order <orderId> --txn <buyerTransactionId>
```

## Use with Claude Code

REHEARSAL runs as a local MCP server over stdio. There is no HTTP transport and
nothing listens on a port. Claude Code starts it as a child process, and it
inherits Claude Code's environment, so the keys stay in your OS environment
variables and never go in a config file.

Register it once (use your own path to the repo):

```
claude mcp add rehearsal --scope user -- node C:/path/to/rehearsal/node_modules/tsx/dist/cli.mjs C:/path/to/rehearsal/bin/mcp.ts
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

### Alongside PayPal's AI Toolkit

PayPal's own MCP server acts on one record at a time: get an order, list
disputes, accept a claim, send an invoice reminder. It cannot open a dispute,
send a payout or produce a webhook redelivery (R-002), so on its own it has
little realistic state to act on. REHEARSAL builds that state. Run both in the
same Claude Code session, both pointed at the sandbox:

1. REHEARSAL `plan_scenario` and `run_scenario` build the situation: a dispute
   waiting on the merchant, an overdue invoice, an unclaimed payout, a refunded
   capture.
2. The toolkit's tools work it: `list_disputes`, `get_dispute`,
   `accept_dispute_claim`, `send_invoice_reminder`, `list_transactions`.
3. REHEARSAL `find_edge_cases` checks how your own app handled the events.

## Web console (`console/`)

**Stage A** (R-035): all five surfaces built from the approved mocks:
- trust panel;
- scenario builder;
- run replays;
- edge-case finder;
- judge gate.

They read recorded replays of REHEARSAL's own runs. Every page that shows recorded data says REPLAY. Nothing in Stage A calls PayPal or a model; a test fails if any console source makes an outbound `fetch`.

```
cd console
npm install
npm run dev          # http://localhost:3000
npm test             # gate, headers, fixtures, Stage A boundaries
npm run build        # fetches Switzer first (see below)
```

**Judge gate (R-034):**
- The passcode is compared server-side, as an scrypt hash, with `timingSafeEqual`.
- Lockout is keyed by client address (`x-vercel-forwarded-for` only, which Vercel sets and does not take from the client; IPv6 counted by /64): 5 wrong tries lock that address for an hour, counted by each server instance on its own.
- A global count of wrong tries is logged when it crosses its ceiling but refuses no one (R-036), so the right passcode always works from an address that is not locked. Guessing from many addresses is bounded by a Vercel WAF rate limit on `POST /api/gate`, set in the Vercel dashboard, not in this repo.
- A passing passcode gets a signed `__Host-` session cookie: httpOnly, Secure, SameSite=Strict, 2 hours.
- Behind the gate, Stage A only says that live runs arrive in Stage B.

Two environment variables, names only:

| Variable | What |
|---|---|
| `CONSOLE_PASSCODE_HASH` | the passcode's hash. Make it with `npm run hash-passcode`, which reads the passcode from stdin, never from the command line |
| `CONSOLE_SESSION_SECRET` | 32 or more random characters that sign the session cookie |

Without both, the gate stays shut and says so.

**Fonts:**
- **Switzer** is self-hosted (R-027), but its license (ITF FFL 2.0) forbids putting the font files in a repository. So `npm run build` downloads them from Fontshare first, into a gitignored folder, and refuses any file whose sha256 differs from the pinned one.
- **DM Mono** is OFL and committed, with its license.

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
