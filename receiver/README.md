# REHEARSAL receiver

A deliberately small public endpoint that records when each PayPal webhook event
arrives, verifies its signature when credentials are present, and hands the list
back behind a shared secret.

| Route | Method | Auth | Does |
|---|---|---|---|
| `/api/paypal/webhook` | POST | none (PayPal calls it) | records an arrival, returns 200 |
| `/api/paypal/ledger` | GET | `Authorization: Bearer <token>` | returns the arrivals |

## Why there is a database

The first version kept arrivals in process memory. On Vercel the instance that
serves a read is not the instance that handled the webhook POST, so arrivals
were written into memory nothing could ever read. Proved directly rather than
inferred: a self-posted event returned HTTP 200 and was then invisible across
three consecutive reads from a stable instance.

One Supabase table fixes it. Reads now see every row regardless of which
instance wrote it.

## Setup, in order

### 1. Run the migration

Create a **new** Supabase project. In its SQL editor run, in this order:

1. `migrations/0001_webhook_arrivals.sql` — creates `public.webhook_arrivals`,
   enables RLS with **no policies**, revokes all grants from `anon` and
   `authenticated`, and grants `select, insert` to `service_role`.
2. `migrations/0002_verify.sql` — prints four results. Read them:
   - `rls_enabled` must be `true`
   - `policy_count` must be `0` (RLS on with no policies is the goal, not a warning)
   - the grants query must return **zero rows**
   - `service_select` and `service_insert` must both be `true`

Do not take the migration's success message as evidence. Read the four results.

### 2. Set the Vercel environment variables

In the receiver's Vercel project, Settings, Environment Variables:

| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Project URL. Any other host is refused. |
| `SUPABASE_SERVICE_ROLE_KEY` | the project's secret key (`sb_secret_...`) | Server-side only. Never `NEXT_PUBLIC_`. Sent on `apikey` only. |
| `REHEARSAL_RECEIVER_TOKEN` | a long random string you invent | Must match the same variable where gate 5 runs. |
| `PAYPAL_SELLER_CLIENT_ID` | sandbox seller client id | Optional, enables signature verification. |
| `PAYPAL_SELLER_CLIENT_SECRET` | sandbox seller secret | Optional, same. |
| `REHEARSAL_WEBHOOK_ID` | `9FU40962XL437872W` | Optional, same. Gate 5 prints this id. |

**Set these before or with the deploy.** Until both Supabase variables are set,
the webhook endpoint answers 503 on purpose rather than accepting a delivery it
would then drop. PayPal retries a 503, so events are delayed and not lost.

### 3. Deploy

```
cd receiver
npm install
npm test        # 16 tests, no network
npm run build
```

Then deploy to Vercel as its own project. The deployment must be publicly
reachable, so Deployment Protection has to be off or PayPal cannot deliver.

## Where the key can and cannot go

The service role key bypasses RLS, so it is the one real secret here. It is read
from `process.env` at request time and travels only in request headers to the
pinned `supabase.co` host. It is never logged, never interpolated into an error
message, never returned to a caller, and never needed where the gates run: the
gate reads the ledger over HTTP using `REHEARSAL_RECEIVER_TOKEN` instead.

`assertSupabaseUrl` rejects any host that is not `*.supabase.co` over https,
because a `SUPABASE_URL` that could be anything is an exfiltration path for
every webhook we record.

## Why signature verification is the point

PayPal's own Webhook Simulator sends mock events that, per PayPal's
[documentation](https://developer.paypal.com/api/rest/webhooks/simulator/), cannot be verified through the
verify-webhook-signature endpoint, cannot be resent, and match no real event
or transaction. An app that verifies through that endpoint therefore
**rejects** every simulator event. REHEARSAL fires real events, so they verify. A recorded `verified: null` means verification was
not attempted because the receiver holds no credentials; it does not mean the
signature failed.
