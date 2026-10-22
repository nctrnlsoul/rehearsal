# REHEARSAL receiver

A deliberately small public endpoint for **gate 5**. It records when each PayPal
webhook event arrives, verifies the signature when credentials are present, and
hands the list back behind a shared secret.

Two routes:

| Route | Method | Auth | Does |
|---|---|---|---|
| `/api/paypal/webhook` | POST | none (PayPal calls it) | records an arrival, returns 200 |
| `/api/paypal/ledger` | GET | `Authorization: Bearer <token>` | returns the arrivals |

## Deploy it (Brian)

```
cd receiver
npm install
```

Then deploy to Vercel as its own project. In the Vercel project's
**Environment Variables** screen set:

- `REHEARSAL_RECEIVER_TOKEN` — **required.** Any long random string you invent.
  Without it `/api/paypal/ledger` returns 503 and reads nothing.
- `PAYPAL_SELLER_CLIENT_ID`, `PAYPAL_SELLER_CLIENT_SECRET`, `REHEARSAL_WEBHOOK_ID`
  — optional. With all three set the receiver verifies every event's signature
  against PayPal. Leave them out and arrivals record `verified: null`.

Set the **same** `REHEARSAL_RECEIVER_TOKEN` value as a Windows environment
variable so the gate can read the ledger. Use the environment variable screen,
not `setx`, and do not paste the value into chat.

Then give me only the deployment URL. Set it as `REHEARSAL_RECEIVER_ORIGIN`
(origin only, no path), for example `https://rehearsal-receiver.vercel.app`.

`REHEARSAL_WEBHOOK_ID` is chicken-and-egg: gate 5 creates the webhook and prints
its id. Deploy without it, run gate 5 once to get the id, set it, redeploy, and
the second run records real `verified: true` instead of `null`.

## The limitation this design admits

The ledger is **in-memory, per instance**. If Vercel spreads the five events
across two instances, a read from one instance cannot see rows written to the
other. Every row therefore carries an `instanceId`, and the gate treats a
multi-instance ledger with anything missing as **ambiguous**, never as a lost
event. `preferredRegion` is pinned to one region to make the split unlikely.

If gate 5 comes back ambiguous more than once, the fix is a durable store
(Supabase, one table) rather than retrying and hoping.

## Why signature verification is the point

PayPal's own Webhook Simulator sends mock events that, per PayPal's
documentation, cannot be verified, resent, or looked up. An app that correctly
verifies signatures therefore **rejects** every simulator event. REHEARSAL fires
real events, so they verify. That is the difference the console should lead with.
