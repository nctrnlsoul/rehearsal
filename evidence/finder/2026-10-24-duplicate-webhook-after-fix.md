# Edge-case finder report

- 0 bug(s), 1 passed, 0 inconclusive, of 1 classes

## ok  duplicate-webhook

- A redelivered capture event fulfils the order twice
- PayPal event: `PAYMENT.CAPTURE.COMPLETED`
- Expected: one fulfilment for an event id, however many times it is delivered
- Actual: event WH-1XN5343594084053N-3NH67648AD6825106 was fulfilled once and its 1 redelivery(s) recognised and ignored
- Likely fix: none needed
- Run: `20261024011812-208f4e`

No bugs found in the classes that were actually exercised. Read the inconclusive ones: they were not tested, which is not the same as passing.
