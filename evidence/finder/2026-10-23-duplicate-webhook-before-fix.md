# Edge-case finder report

- 1 bug(s), 0 passed, 0 inconclusive, of 1 classes

## BUG  duplicate-webhook

- A redelivered capture event fulfils the order twice
- PayPal event: `PAYMENT.CAPTURE.COMPLETED`
- Expected: one fulfilment for an event id, however many times it is delivered
- Actual: event WH-23242717T8452430B-4FP87531JX1278159 was delivered 2 times and fulfilled 2 times
- Likely fix: treat the webhook event id as an idempotency key: record it and ignore an event already seen before fulfilling
- Run: `20261023231552-60ea96`

Found 1 bug(s): duplicate-webhook.
