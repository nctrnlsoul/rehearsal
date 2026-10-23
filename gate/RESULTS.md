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
| 6 dispute | **FAIL (BLOCKED)** | Needs one browser approval click |

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

**Gate 6, one approval click.** A PayPal-wallet payment has no server-to-server
approval path, which is why this is the one human step in the suite. Open the
approval URL above, log in as the sandbox **buyer business** account, approve,
then `npm run gate:6` again. The gate is resumable and picks up from the
approved order.

## Known unknown, not yet proven either way

Sandbox dispute **creation** is absent from PayPal's published OpenAPI spec
(`customer_disputes_v1.json` has only GET and PATCH on `/v1/customer/disputes`),
even though both apps' tokens carry a `disputes/create` scope. `require-evidence`
and `adjudicate` are both in the spec and both sandbox-only, with the enums the
gate uses. So gate 6 phase C is a genuine open question that only running it
will answer. The scope says yes, the spec says no.

Confirmed independently of the recon note: neither app has
`disputes/update-buyer`, so `change-reason` is genuinely unavailable.

## What the passing gates mean for scope

The biggest risk the 2026-10-20 recon named was "creating activity with no human
buyer." For cards that risk is now gone: gate 1 captured USD 42.00 with no
browser, no redirect and no second call. Orders, refunds and payouts are all
fully API-drivable. Only the wallet-payment path needs a human, and only once
per disputed transaction.
