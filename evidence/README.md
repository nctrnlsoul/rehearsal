# Evidence

Reports and run state the edge-case finder wrote during real runs against the PayPal sandbox
and the sample store (`store/`). Each file is the CLI's own report, copied
byte for byte from the local `runs/` folder, which is not committed. Ids in
them are sandbox ids. The older reports use British spelling; the code moved
to US spelling afterwards, and the reports were not edited.

| File | What it shows |
|---|---|
| `finder/2026-10-23-duplicate-webhook-before-fix.md` | BUG: the store, with its planted bug (no dedupe by event id), fulfilled one redelivered capture event twice. |
| `finder/2026-10-24-duplicate-webhook-after-fix.md` | OK: after the one-line fix, the same redelivery was recognized and ignored. |
| `finder/2026-10-24-refund-after-partial.md` | OK: two refunds PayPal accepted, each recorded once. |

The run state each report names is in `runs/` here, as the engine saved it
(`20261023231552-60ea96`, `20261024011812-208f4e`, `20261024021827-128499`).
The console's recorded replays are built from these files.

The fix between the first two is commit `d6b8ff6`
(`fix(store): dedupe webhook events by event id`).

These reports predate v0.6.1. Under v0.6.1's rules the two OK verdicts still
hold: each rests on PayPal accepting every step under test and the store's
own rows.
