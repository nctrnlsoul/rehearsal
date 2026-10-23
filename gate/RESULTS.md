# Day-1 gate results, 2026-10-22, gate 4 cleared 2026-10-23

Run against `api-m.sandbox.paypal.com` only. Every id below is a real sandbox
record created by `gate/` scripts. 119 unit tests pass, typecheck clean.

**Five of seven gates pass. Both remaining blockers need a human, not code.**

| Gate | Verdict | What it proves |
|---|---|---|
| 0 preflight | **PASS** | Auth, host pin refuses live PayPal, and the two apps sit on separate accounts |
| 1 card order | **PASS** | Card captured by API alone, no human step |
| 2 partial refund | **PASS** | Partial refund, independently confirmed on the capture |
| 3 unclaimed payout | **PASS** | Payout item reached UNCLAIMED |
| 4 invoice | **PASS** | Invoice created, sent, and recorded paid by API |
| 5 webhooks | **FAIL (BLOCKED)** | Needs the deployed receiver URL |
| 6 dispute | **FAIL** | Dispute created by API; both sandbox state endpoints refuse at INQUIRY stage |

## Ids created

**Gate 0**
- seller app `APP-4MC37550FA380534T`, account fingerprint `14aec0875b5f`
- buyer app `APP-8US48173BY226571C`, account fingerprint `99adde75345e`
- seller carries 29 scopes after Invoicing was enabled; 0 needed scopes absent

**Gate 1** (single-step Orders v2, intent CAPTURE + `payment_source.card`)
- order `09941019E4718134E`
- capture `8PU31875NP0169201`

**Gate 2** (35% of USD 42.00)
- refund `0W085568EK465174L` on capture `8PU31875NP0169201`
- capture re-read independently: `PARTIALLY_REFUNDED`

**Gate 3** (USD 5.00 to a reserved `example.com` address)
- sender batch `rhsl-771dd312e1c4a8e3a2586673b`
- payout batch `5VTU7DSFVV7LA`
- payout item `23KVSFUKAS6DU`
- batch `PROCESSING`, item `UNCLAIMED` after about 20s

**Gate 4** (USD 25.00, both send-email flags off)
- invoice number `0001`
- invoice `INV2-HDS2-ZYMQ-URF6-NZNS`
- external payment `EXTR-39445688NF757571V`
- status path: `DRAFT`, then `UNPAID` after send, then `MARKED_AS_PAID`

**Gate 6** (phase A only, created by the SELLER app 2026-10-23)
- order `3RK936819N963521R`, status `PAYER_ACTION_REQUIRED`
- approval URL: `https://www.sandbox.paypal.com/checkoutnow?token=3RK936819N963521R`
- supersedes order `322573928N353731T`, which could never be approved (see below)

## Gate 4, cleared 2026-10-23

Two separate causes, found in order.

1. **`403 NOT_AUTHORIZED`.** Gate 0 predicted it from the token scope list:
   neither app carried an invoicing scope. Brian enabled **Invoicing** on the
   `rehearsal-seller` app and the 403 went away. The inferred remedy held.
2. **`415 UNSUPPORTED_MEDIA_TYPE`**, and this one was our bug. The client only
   sent `Content-Type: application/json` when a request carried a body, and
   `generate-next-invoice-number` is a bodyless POST. PayPal cannot type a
   bodyless request without the header. The same bug was sitting in gate 6's
   capture call, which is also bodyless, so it would have cost a second
   debugging round there. Fixed in the adapter for every write, with a
   regression test covering bodyless write, body write, and read.

## Both apps were on one sandbox account, found 2026-10-23

The first gate 6 approval attempt failed. Both apps had been created under the
same sandbox business account (`sb-supl053463227`), so logging in to approve
meant logging in as the merchant, and PayPal refused. Brian created a second
sandbox business account, recreated `rehearsal-buyer` on it, and updated the
buyer credentials.

**Why nothing caught it.** Gate 0 compared `app_id`, and the two app ids were
genuinely different. Distinct apps are not distinct accounts. Every API call
succeeded, all five passing gates stayed green, and the only symptom appeared on
a web page no gate looks at. The gate suite was measuring the wrong thing with
complete confidence.

**The check now in place.** `src/core/accountIdentity.ts` compares the owning
account, read from `GET /v1/identity/oauth2/userinfo?schema=paypalv1.1`, whose
`user_id` is per-account rather than per-app and which works with a plain
client_credentials token. Gate 0 fails `UNSAFE` if the two subjects match, if the
two apps are the same app, or if either owner cannot be read at all, since not
knowing is not evidence of separation. Only a 12-character digest is logged, so
no account identity reaches a log or a receipt.

**Proven in both directions.** 12 unit tests, plus a live negative control that
pointed the buyer slot at the seller's credentials by reference and confirmed
gate 0 returns `FAIL (UNSAFE)` with identical fingerprints. A guard that has
only ever been seen to pass is not yet known to work.

## The two remaining blockers, with remedies

**Gate 5, receiver URL.** `receiver/` is written, builds clean, and its nine
endpoint probes all behave as specified locally. It needs deploying to Vercel
and `REHEARSAL_RECEIVER_ORIGIN` plus `REHEARSAL_RECEIVER_TOKEN` setting. See
`receiver/README.md`. The deployment must be publicly reachable, so Vercel
Deployment Protection has to be off for that project or PayPal cannot deliver.

**Gate 6, the approval click is done.** Order `3RK936819N963521R` was approved as
the sandbox buyer business account and captured as `1G18470618640833J`. A
PayPal-wallet payment has no server-to-server approval path, so one human step
per disputed transaction is structural and will not go away.

What remains on gate 6 is not an approval but the claim-stage problem above.

## Gate 6, what is now proven, 2026-10-23

**Buyer-side dispute creation by API works.** This was the open question and the
answer is yes. `POST /v1/customer/disputes` with the buyer app's own
client_credentials token, no `PayPal-Auth-Assertion` header, returned **201** and
created dispute `PP-R-DXC-10194171` on buyer transaction `176520997B301664B`.
The endpoint is absent from PayPal's published OpenAPI spec, so this is a
capability the spec does not admit to having.

Three things it took to get there, each a finding in its own right:

1. **`buyer_transaction_id`, not the seller's capture id.** Using the capture id
   returned `400 TRANSACTION_NOT_ELIGIBLE`. That error also proved the body shape
   itself was accepted, including the `extensions` block.
2. **The buyer-side transaction id is not reachable from the seller side at all.**
   Dumped both the full order and the full capture: the only related id is
   `supplementary_data.related_ids.order_id`. Buyer-side Transaction Search
   returns `403` because the buyer app has no reporting scope. Brian read the id
   from the buyer's activity page.
3. **The new dispute's id exists only in a self link.** The 201 body is
   `{"links":[{"href":".../disputes/PP-R-DXC-10194171","rel":"self"}]}` with no
   `id` or `dispute_id` field. Our first run reported FAIL on a write that had
   actually succeeded. Fixed in `src/core/paypalLinks.ts` with a test against the
   literal response body.

**Where it is stuck: both sandbox state endpoints refuse at the INQUIRY stage.**

```
status                   UNDER_REVIEW        <- the spec's stated precondition, satisfied
dispute_state            UNDER_PAYPAL_REVIEW
dispute_life_cycle_stage INQUIRY             <- the actual blocker
require-evidence  -> 400 ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE
adjudicate        -> 400 ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE
```

The spec states the precondition for both as "the dispute `status` must be
`UNDER_REVIEW`". Our status **is** `UNDER_REVIEW` and both still refuse, so that
documented precondition is necessary but **not sufficient**. Both are claim-stage
tools, and PayPal does not adjudicate an inquiry.

**Getting to the claim stage is the unsolved part.** `POST /{id}/escalate`
returns `403 ACTION_NOT_ALLOWED` with the buyer token, which independently
confirms the recon note that no `disputes/update-buyer` scope means no buyer-side
state changes. With the **seller** token it returns `200`, but the stage stayed
`INQUIRY` afterwards. The only action PayPal offers now is `provide_evidence`,
which takes `multipart/form-data` rather than JSON.

**Most likely answer, untested.** The recon note lists sandbox **create
chargeback** as a capability distinct from create dispute. A dispute that starts
as a chargeback would already be at the stage these two endpoints want. Testing
it needs another approved order, so another human click and another manual
transaction id read.

**Observed sandbox dispute lifecycle**, which is documented nowhere and takes
minutes per transition:

```
created -> UNDER_REVIEW / UNDER_PAYPAL_REVIEW   no actions offered
        -> WAITING_FOR_SELLER_RESPONSE / REQUIRED_ACTION
           actions: send_message, escalate, accept_claim, provide_evidence, make_offer
        -> after seller escalate: UNDER_REVIEW / UNDER_PAYPAL_REVIEW, still INQUIRY
           actions: provide_evidence only
```

## The two remaining blockers, with remedies

## What the passing gates mean for scope

The biggest risk the 2026-10-20 recon named was "creating activity with no human
buyer." For cards that risk is now gone: gate 1 captured USD 42.00 with no
browser, no redirect and no second call. Orders, refunds and payouts are all
fully API-drivable. Only the wallet-payment path needs a human, and only once
per disputed transaction.
