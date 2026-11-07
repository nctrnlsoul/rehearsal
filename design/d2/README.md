# Direction D2: the approved console redesign (R-048, R-050)

Picked by Brian on 2026-10-25 from Claude Design ("REHEARSAL Run Timeline Directions"). These files are the
design reference exported from that canvas: the run timeline at 1440 and 390 wide, as HTML and PNG.
They are a reference to build from, not code to ship. The sample data in them (run 20261024011812-208f4e,
a payout step, USD 40 orders) is illustrative; the console must show real run data.

Measured from the reference:
- Type: Instrument Sans (UI) and JetBrains Mono (ids, paths, times only). Both OFL; self-host, never a
  third-party font call (CSP). One element in the reference falls back to Times New Roman: do not copy that.
- Colors: page #f6f5f2, cards #ffffff, ink #17181a, muted text #5b5e63, borders #e4e2dc,
  hero #1b353a, accent teal #0e6670, mint #6fd3c1, success #137a43 (pale #e8f4ec),
  waiting amber #f0b03a with text #8a5a00.
- Structure: answer first (one plain sentence), "Proof from PayPal" strip in arrival order, 4 summary
  figures, then one card per step with what Rehearsal sent on the left, the reply time in the middle and
  what PayPal replied on the right, on the SAME row. Details collapsed by default.
- The NorthSchema blossom in the header only (black on light), text footer "by NorthSchema".
