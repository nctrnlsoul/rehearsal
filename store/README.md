# REHEARSAL sample store

The sample merchant app the edge-case finder tests. It receives PayPal webhooks
at `POST /api/paypal/webhook`, acts on an event only after PayPal's
verify-webhook-signature call answers `SUCCESS`, and records every delivery in
`store_order_events`. `GET /api/store/state` returns that ledger behind a shared
token, for the finder and the console.

It carries one planted bug on purpose: `DEDUPE_BY_EVENT_ID` in
`lib/merchant.ts` decides whether a redelivered event is fulfilled again. The
finder's duplicate-webhook class catches it while the flag is `false`; with it
`true` the same check passes. Both reports are in
[evidence/finder/](../evidence/finder/).

## Setup, in order

1. **Database.** It shares the receiver's Supabase project (see
   [receiver/README.md](../receiver/README.md)) but uses its own table. In that
   project's SQL editor run `migrations/` in number order, and read each
   `_verify.sql` result rather than trusting the success message.
2. **Environment.** Every variable, with what happens when it is missing, is in
   [.env.example](.env.example). Set them in the store's own Vercel project.
3. **Deploy** `store/` as its own Vercel project.
4. **Webhook.** Register a webhook on the sandbox seller app whose URL is exactly
   `https://<store>/api/paypal/webhook`, in the PayPal developer dashboard or by
   running a scenario whose `webhook.target` is that URL (see the root README).

## Tests

```
cd store
npm install
npm test
```
