# Day-1 gate results, 2026-10-22, gate 4 cleared 2026-10-23

Run against `api-m.sandbox.paypal.com` only. Every id below is a real sandbox
record created by `gate/` scripts. 107 unit tests pass, typecheck clean.

**Five of seven gates pass. Both remaining blockers need a human, not code.**

| Gate | Verdict | What it proves |
|---|---|---|
| 0 preflight | **PASS** | Both apps authenticate on sandbox; host pin refuses live PayPal |
| 1 card order | **PASS** | Card captured by API alone, no human step |
| 2 partial refund | **PASS** | Partial refund, independently confirmed on the capture |
| 3 unclaimed payout | **PASS** | Payout item reached UNCLAIMED |
| 4 invoice | **PASS** | Invoice created, sent, and recorded paid by API |
| 5 webhooks | **FAIL (BLOCKED)** | Needs the deployed receiver URL |
| 6 dispute | **FAIL (BLOCKED)** | Needs one browser approval click |

## Ids created

**Gate 0**
- seller app `APP-4MC37550FA380534T`
- buyer app `APP-07T66442GY4861820`

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

**Gate 6** (phase A only)
- order `322573928N353731T`, status `PAYER_ACTION_REQUIRED`
- approval URL: `https://www.sandbox.paypal.com/checkoutnow?token=322573928N353731T`

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
