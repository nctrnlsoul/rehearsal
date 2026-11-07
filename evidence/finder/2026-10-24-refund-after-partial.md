# Edge-case finder report

- 0 bug(s), 1 passed, 0 inconclusive, of 1 classes

## ok  refund-after-partial

- A second refund after a partial one
- PayPal event: `PAYMENT.CAPTURE.REFUNDED`
- Expected: one refund event recorded per refund PayPal accepted
- Actual: 2 refund(s) accepted and each recorded once
- Likely fix: none needed
- Run: `20261024021827-128499`

No bugs found in the classes that were actually exercised. Read the inconclusive ones: they were not tested, which is not the same as passing.
