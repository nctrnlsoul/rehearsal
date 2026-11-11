import { describe, expect, it } from "vitest";
import type { LiveRead } from "../lib/liveView";
import { RUNS } from "../lib/replays";
import { HOSTED_REPLAYS, hostedEndS, hostedRead } from "../lib/hostedReplays";
import { HOSTED_FINDER_CLASSES } from "../lib/hosted";
import { DISPUTE_LAG, type RunStory, SLOW_SEND, dur, humanReason, money, runStory, verdictHero } from "../lib/runStory";
import { type Fixture, TOKEN_REFUSED_DETAIL, absolute, disputeRun, recordedAt, tinyBakery, tokenRefused } from "./fixtures/liveRuns";

const T0 = Date.parse("2026-11-07T20:39:53Z");

function readOf(f: Fixture, nowS: number): LiveRead {
  const finished = ["complete", "halted", "abandoned", "failed"].includes(f.status);
  return {
    run: {
      id: "20261107203953-bd8593",
      kind: "scenario",
      plan_source: "recorded",
      plan_id: "plan-20261023193216",
      scenario_sha256: null,
      status: f.status,
      state: null,
      halt_reason: f.reason ?? null,
      created_at: new Date(T0).toISOString(),
      started_at: new Date(T0).toISOString(),
      heartbeat_at: new Date(T0 + nowS * 1000).toISOString(),
      finished_at: finished ? new Date(T0 + nowS * 1000).toISOString() : null,
    },
    events: absolute(f, T0).map((e, i) => ({ ...e, seq: i + 1 })),
    now: new Date(T0 + nowS * 1000).toISOString(),
  };
}

const story = (f: Fixture, nowS: number) => runStory(readOf(f, nowS));
const everything = (s: RunStory) => [s.headline, s.lead ?? "", s.proofLine, ...s.cards.flatMap((c) => [c.title, c.sentWord, c.problem ?? ""])].join(" | ");

describe("the live state sequence, on a Tiny Bakery run", () => {
  it("names every step and its amount before any of them runs", () => {
    const s = story(tinyBakery(0.5), 0.5);
    expect(s.cards.map((c) => `${c.title}${c.amount === null ? "" : `, ${c.amount}`}`)).toEqual([
      "Capture a card payment, USD 45",
      "Capture a card payment, USD 60",
      "Create an invoice, USD 120",
      "Send the invoice",
      "Record the invoice payment, USD 120",
    ]);
    expect(s.cards.every((c) => c.sent === "queued")).toBe(true);
    expect(s.figures.amountNote).toBe("of USD 345 planned");
  });

  it("goes queued, sending, accepted and waiting, delivered, with the current step highlighted", () => {
    const sending = story(tinyBakery(5.5), 5.5);
    expect(sending.headline).toBe("Running step 3 of 5: Create an invoice.");
    // Past tense only once PayPal has accepted it.
    expect(sending.cards[0]!.title).toBe("Payment captured");
    expect(sending.progress).toEqual({ at: 3, of: 5 });
    expect(sending.cards[2]!).toMatchObject({ sent: "sending", sentWord: "Sending to PayPal", current: true });
    expect(sending.cards[0]!).toMatchObject({ sent: "accepted", reply: "waiting" });
    expect(sending.cards[3]!).toMatchObject({ sent: "queued", reply: "none-expected" });

    const later = story(tinyBakery(20), 20);
    expect(later.cards[0]!.reply).toBe("delivered");
    expect(later.cards[0]!.replies[0]!).toMatchObject({ plain: "Payment completed", rank: 1, exact: true });
    expect(Math.round(later.cards[0]!.replies[0]!.latencyS!)).toBe(12);
    expect(later.cards[2]!.replies[0]!).toMatchObject({ plain: "Invoice created", rank: 2 });
    expect(later.cards[1]!.reply).toBe("waiting");
    expect(Math.round(later.cards[1]!.waitingS!)).toBe(16);
  });

  it("says every step was sent, and how many events it still waits on, never that every step has run", () => {
    const s = story(tinyBakery(22), 22);
    expect(s.tone).toBe("waiting");
    expect(s.headline).toBe("All 5 steps sent.");
    expect(s.lead).toBe("Waiting on PayPal for 2 events. 2 of 4 arrived so far.");
    expect(everything(s)).not.toMatch(/Every step has run/);
  });

  it("ends with the answer first, the proof in arrival order, and the unjoined event listed apart", () => {
    const s = story(tinyBakery(40), 40);
    expect(s.headline).toBe("All 5 steps done.");
    expect(s.lead).toBe("4 of 4 expected events arrived, all verified.");
    expect(s.proof.map((p) => `Step ${p.step}, ${p.label} ${dur(p.latencyS!)}`)).toEqual(["Step 1, Payment 12s", "Step 3, Invoice 12s", "Step 2, Payment 20s", "Step 5, Invoice paid 16s"]);
    // Step 3's invoice event beat step 2's payment, so the page says so in one sentence.
    expect(s.outOfOrder).toBe("Step 3's webhook arrived before step 2's. Webhooks can arrive out of order, as here; your app has to handle that.");
    expect(s.figures).toEqual({ steps: "5 of 5", amount: "USD 345", amountNote: null, disputed: null, slowest: "20s", signatures: "4 of 4", signaturesOk: true });
    expect(s.counts).toEqual({ expected: 4, arrived: 4, verified: 4 });
    expect(s.rejected).toBeNull();
    expect(s.cards[3]!.reply).toBe("none-expected");
    expect(s.other).toHaveLength(1);
    expect(s.other[0]!).toMatchObject({ eventType: "INVOICING.INVOICE.UPDATED", plain: "PayPal says the invoice changed" });
  });
});

describe("a halted run, as run 20261107203953-bd8593 halted", () => {
  it("says stopped at step 1, in plain words, with nothing sent, and keeps the code for Details", () => {
    const s = story(tokenRefused(), 2);
    expect(s.tone).toBe("stopped");
    expect(s.headline).toBe("Stopped at step 1.");
    expect(s.lead).toBe("PayPal refused the seller app's login (its client id and secret do not match a sandbox app). Nothing was sent.");
    expect(s.cards[0]!).toMatchObject({ sent: "not-sent", sentWord: "Not sent" });
    expect(s.cards[0]!.details.paypalCode).toBe("invalid_client");
    expect(s.cards[0]!.details.detail).toBe(TOKEN_REFUSED_DETAIL);
    expect(everything(s)).not.toMatch(/handler threw|Every step has run|may have written/);
  });

  it("never claims nothing was sent for the old record, which could not prove it", () => {
    expect(humanReason("step card-order-1 ended in an unknown state: handler threw: Error: sandbox token request failed with http 401 (invalid_client)")).toBe(
      "PayPal refused the app's login partway through the step (http 401, invalid_client). It may already have written to PayPal; nothing here will retry it.",
    );
  });

  it("matches the run's state while a halted run still listens for events", () => {
    const f = tinyBakery(12);
    f.events.push({ s: 12, kind: "run_halted", data: { reason: "step card-order-2 failed: http 422: PayPal refused the request" } });
    const halted: Fixture = {
      ...f,
      events: f.events.map((e) => (e.step === "card-order-2" && e.kind === "step_finished" ? { ...e, data: { ...e.data, status: "failed", detail: "http 422: PayPal refused the request", ids: {} } } : e)).filter((e) => !(e.step !== undefined && ["invoice-1", "invoice-1-send", "invoice-1-payment"].includes(e.step))),
    };
    const s = story(halted, 13);
    expect(s.headline).toBe("Stopped at step 2.");
    expect(s.lead).toMatch(/^PayPal refused the request \(http 422\)\. Nothing was written\./);
    expect(s.lead).toMatch(/Still listening for 1 event from the steps PayPal accepted\.$/);
    expect(everything(s)).not.toMatch(/All 5 steps|Every step has run/);
  });
});

describe("the plain-English map", () => {
  it.each([
    ["not sent: 47 s were left in this server's time, and this step can take 30 s", "Not sent: this server had 47 s left, and this step can take 30 s. Nothing was sent."],
    ["the hosted purchase bank has no purchase ready to dispute", "Not sent: no banked purchase is ready to dispute. Nothing was sent."],
    ["http 504: the write may or may not have executed", "PayPal's reply (http 504) does not say whether the request went through. It may have; nothing here will retry it."],
    ["handler threw: TypeError: x is undefined", "The step stopped on an error (TypeError). It may have written to PayPal; nothing here will retry it."],
    ["could not read the webhook list: sandbox token request failed with http 401 (invalid_client)", "PayPal refused the app's login (its client id and secret do not match a sandbox app). Nothing was sent."],
  ])("%s", (raw, plain) => {
    expect(humanReason(raw)).toBe(plain);
  });

  it("never prefixes a sentence with the engine's own words", () => {
    for (const raw of ["handler threw: Error: boom", "step x failed: http 400: PayPal refused the request"]) expect(humanReason(raw)).not.toMatch(/handler threw|^step x/);
  });

  it("reads whole amounts without cents, and durations in seconds and minutes", () => {
    expect(money("USD", "45.00")).toBe("USD 45");
    expect(money("USD", "45.50")).toBe("USD 45.50");
    expect(dur(12.4)).toBe("12s");
    expect(dur(82)).toBe("1m 22s");
  });
});

describe("a recorded run cut into a live fixture", () => {
  it("reads the same as its replay at that moment", () => {
    const run = RUNS[1]!;
    const s = story(recordedAt(run, 10), 10);
    expect(s.headline).toBe("Running step 2 of 2: Ask PayPal to resend an event.");
    expect(s.cards[0]!).toMatchObject({ sent: "accepted", reply: "waiting", amount: "USD 25" });
  });
});

// The independent verifier's findings on 9f6e65e, each pinned.
describe("claims the data cannot back are never made", () => {
  const unknownFirst = (): Fixture => {
    const f = tokenRefused();
    return {
      ...f,
      reason: "step card-order-1 ended in an unknown state: http 504: the write may or may not have executed",
      events: f.events.map((e) =>
        e.kind === "step_finished" ? { ...e, data: { ...e.data, status: "unknown", detail: "http 504: the write may or may not have executed" } } : e.kind === "run_halted" ? { ...e, data: { reason: "step card-order-1 ended in an unknown state: http 504" } } : e,
      ),
    };
  };

  it("never says nothing was sent when a step's outcome is unknown", () => {
    const s = story(unknownFirst(), 3);
    expect(s.proofLine).not.toMatch(/Nothing was sent/);
    expect(s.lead).toMatch(/may have; nothing here will retry it|may have written to PayPal/);
    expect(s.figures.amountNote).toBe("of USD 345 planned; one step's outcome is unknown");
  });

  // Audit 2026-11-07 evening: anyone can post junk to the store's public
  // webhook, so a refused post must never move PayPal's numbers.
  it("keeps posts the store rejected apart, never adding them to PayPal's numbers", () => {
    const f = tinyBakery(40);
    f.events.push({ s: 30, kind: "note", data: { refused_in_window: 3 } });
    const s = story(f, 41);
    expect(s.figures).toMatchObject({ signatures: "4 of 4", signaturesOk: true });
    expect(s.counts).toEqual({ expected: 4, arrived: 4, verified: 4 });
    expect(s.lead).toBe("4 of 4 expected events arrived, all verified.");
    expect(s.proofLine).toBe("4 of 4 arrived. All verified.");
    expect(s.rejected).toBe("3 posts to the store were refused: malformed, or a signature that failed or could not be checked. None is counted as PayPal's.");
  });

  it("says nothing about order when every webhook arrived in step order", () => {
    const s = runStory(hostedRead(HOSTED_REPLAYS[0]!, hostedEndS(HOSTED_REPLAYS[0]!)));
    expect(s.outOfOrder).toBeNull();
    expect(s.proof.map((p) => p.step)).toEqual([1, 2, 3, 5]);
  });

  it("says an event that landed while the step was still checking arrived during it, never 'in 0s'", () => {
    const f = tinyBakery(40);
    // The step finished at 2.4 s; this copy is recorded at 1.8 s.
    const ev = f.events.find((e) => e.kind === "delivery" && e.data?.["event_id"] === "WH-E2E-CAPTURE-1")!;
    ev.data = { ...ev.data, received_at: [{ rel: 1.8 }] };
    const r = story(f, 41).cards[0]!.replies[0]!;
    expect(r.early).toBe(true);
    expect(r.latencyS).toBeNull();
  });

  it("marks an upper-bound latency as one wherever it is printed", () => {
    const f = tinyBakery(40);
    for (const e of f.events) if (e.kind === "delivery") e.data = { ...e.data, received_at: [] };
    const s = story(f, 41);
    expect(s.figures.slowest).toMatch(/^at most /);
    expect(s.proof.every((p) => !p.exact)).toBe(true);
  });

  it("names a step by what it asks for until PayPal accepts it", () => {
    const s = story(tokenRefused(), 3);
    expect(s.cards[0]!.title).toBe("Capture a card payment");
    expect(s.cards[2]!.title).toBe("Create an invoice");
  });
});

// Found by the v0.7.3 verifier: two hosted classes read PayPal's own record,
// so a headline that credits the store would be false for them.
describe("the finder verdict hero, for every hosted class", () => {
  it("leads with the verdict word and never credits the store for a class it does not decide", () => {
    for (const id of HOSTED_FINDER_CLASSES) {
      for (const verdict of ["bug", "ok", "inconclusive"] as const) {
        const hero = verdictHero({ classId: id, verdict, title: "A test class title", expected: "", actual: "what was observed", likelyFix: "", skipped: null })!;
        expect(hero.headline, `${id} ${verdict}`).toMatch(verdict === "bug" ? /^BUG: / : verdict === "ok" ? /^OK: / : /^INCONCLUSIVE: /);
        if (id !== "duplicate-webhook") expect(hero.headline, `${id} ${verdict}`).not.toMatch(/store/);
      }
    }
    expect(HOSTED_FINDER_CLASSES).toEqual(expect.arrayContaining(["duplicate-webhook", "overdue-invoice", "unclaimed-payout"]));
  });
});

// v0.7.4, brief items 1 to 5 and 8 (R-053).
describe("v0.7.4: a dispute's pairing, a slow step's clock, and a finished run's words", () => {
  const RESEND = RUNS[1]!;
  const figuresText = (s: RunStory) => Object.values(s.figures).join(" | ");

  it("item 1: shows PayPal's pairing_mismatch line on the dispute card, and only when the engine wrote one", () => {
    const off = story(disputeRun(210, "E2E-CAPTURE-OTHER-9"), 210);
    expect(off.cards[0]!.pairing).toBe("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says E2E-CAPTURE-OTHER-9");
    // The dispute is real: the step still reads as accepted, never as failed.
    expect(off.cards[0]!.sent).toBe("accepted");
    expect(off.cards[0]!.problem).toBeNull();
    expect(off.cards[0]!.details.ids).toContainEqual(["paypal_seller_transaction_id", "E2E-CAPTURE-OTHER-9"]);

    expect(story(disputeRun(210, "E2E-CAPTURE-BANK-1"), 210).cards[0]!.pairing).toBeNull();
    expect(story(disputeRun(210), 210).cards[0]!.pairing).toBeNull();
    expect(story(tinyBakery(40), 40).cards.every((c) => c.pairing === null)).toBe(true);
  });

  // Found by the cold verifier on d92efb5: a parse of the ids could miss a real mismatch.
  it("item 1: raises the amber line on the token alone, however the ids print or wherever storage cut the detail", () => {
    const withDetail = (detail: string) => {
      const f = disputeRun(210, "E2E-CAPTURE-OTHER-9");
      f.events.find((e) => e.kind === "step_finished")!.data!["detail"] = detail;
      return story(f, 210).cards[0]!.pairing;
    };
    expect(withDetail("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says \\u{200b}; dispute X open")).toBe("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says \\u{200b}");
    expect(withDetail("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says")).toBe("pairing_mismatch: banked capture E2E-CAPTURE-BANK-1, PayPal says");
    expect(withDetail(`pairing_mismatch: banked capture ${"C".repeat(282)}`)).toMatch(/^pairing_mismatch: banked capture C+$/);
    expect(withDetail("dispute X open; PayPal did not name the capture")).toBeNull();
  });

  it("item 2: a resend in flight counts its seconds and says why it takes this long", () => {
    const c = story(recordedAt(RESEND, 45), 45).cards.find((x) => x.kind === "resend_webhook")!;
    expect(c.sent).toBe("sending");
    expect(c.sendingNote).toBe("PayPal lists a new event before it allows a resend. This usually takes 1 to 2 minutes.");
    const startedS = (Date.parse(RESEND.calls[1]!.startedAt) - Date.parse(RESEND.startedAt)) / 1000;
    expect(c.sendingS!).toBeCloseTo(45 - startedS, 1);
    // The clock moves with the story, never ahead of it.
    const later = story(recordedAt(RESEND, 55), 55).cards.find((x) => x.kind === "resend_webhook")!;
    expect(later.sendingS! - c.sendingS!).toBeCloseTo(10, 1);
    // Once PayPal accepts it, both are gone.
    const after = story(recordedAt(RESEND, 70), 70).cards.find((x) => x.kind === "resend_webhook")!;
    expect(after.sent).toBe("accepted");
    expect([after.sendingS, after.sendingNote]).toEqual([null, null]);
  });

  it("item 2: a dispute in flight gets the same pattern, and a quick step gets neither", () => {
    const c = story(disputeRun(60), 60).cards[0]!;
    expect(c.sent).toBe("sending");
    expect(c.sendingNote).toBe(SLOW_SEND["open_dispute"]);
    expect(c.sendingNote).toBe("PayPal creates the case, then makes it readable.");
    expect(c.sendingS!).toBeCloseTo(59, 1);
    const quick = story(tinyBakery(5.5), 5.5).cards[2]!;
    expect(quick.sent).toBe("sending");
    expect([quick.sendingS, quick.sendingNote]).toEqual([null, null]);
  });

  it("item 3: a finished run with nothing arrived says none arrived, never waiting", () => {
    const done = story(disputeRun(210), 210);
    expect(done.settled).toBe(true);
    expect(done.figures.slowest).toBe("none arrived");
    expect(figuresText(done)).not.toMatch(/waiting/i);
    // While it still listens, waiting is the truth.
    expect(story(disputeRun(150), 150).figures.slowest).toBe("waiting");
    // A halted run is settled too, and nothing expected at all is still "none".
    expect(story(tokenRefused(), 3).figures.slowest).toBe("none");
  });

  it("item 3: a halted run with webhooks still unseen says none arrived", () => {
    const f = tinyBakery(5);
    f.events.push(
      { s: 5.5, kind: "step_finished", step: "invoice-1", data: { kind: "invoice_create", status: "failed", detail: "http 422: PayPal refused the request", ids: {}, finished_at: null } },
      { s: 5.6, kind: "run_halted", data: { reason: "step invoice-1 failed: http 422: PayPal refused the request" } },
      { s: 6, kind: "run_finished", data: { status: "halted" } },
    );
    const s = story({ ...f, status: "halted", reason: "step invoice-1 failed: http 422: PayPal refused the request" }, 6);
    expect(s.settled).toBe(true);
    expect(s.counts.arrived).toBe(0);
    expect(s.counts.expected).toBeGreaterThan(0);
    expect(s.figures.slowest).toBe("none arrived");
  });

  // Found by the cold verifier on d92efb5: an event that beat its step's finish has no latency, yet arrived.
  it("item 3: an event that arrived during its step is never called none arrived", () => {
    const f = tinyBakery(40);
    f.events = f.events.filter((e) => e.kind !== "delivery" || (e.data!["event_id"] as string) === "WH-E2E-CAPTURE-1");
    const d = f.events.find((e) => e.kind === "delivery")!;
    d.data = { ...d.data, received_at: [{ rel: 2.0 }] };
    const s = story(f, 40);
    expect(s.settled).toBe(true);
    expect(s.counts.arrived).toBe(1);
    expect(s.cards[0]!.replies[0]!.early).toBe(true);
    expect(s.figures.slowest).toBe("during its step");
  });

  it("item 4: a dispute run shows the disputed amount, kept apart from what was charged", () => {
    const s = story(disputeRun(210), 210);
    expect(s.figures.amount).toBe("USD 88 disputed");
    expect(s.figures.amountNote).toBeNull();
    expect(s.figures.disputed).toBeNull();
    // Before PayPal accepts it nothing is claimed as disputed.
    expect(story(disputeRun(60), 60).figures.amount).toBe("none");
    // Charges and a dispute in one run: the charged total stays the charged total.
    const mixed = disputeRun(210);
    mixed.events.splice(1, 1, { s: 0, kind: "note", data: { plan: { currency: "USD", steps: [{ id: "order-1", kind: "card_order", amount: "54.00" }, { id: "dispute-1", kind: "open_dispute" }] } } });
    mixed.events.push(
      { s: 0.2, kind: "step_started", step: "order-1", data: { kind: "card_order", attempt: 1 } },
      { s: 0.8, kind: "step_finished", step: "order-1", data: { kind: "card_order", status: "succeeded", detail: "ok", ids: { order_id: "E2E-O", capture_id: "E2E-C" }, finished_at: null } },
    );
    mixed.events.sort((a, b) => a.s - b.s);
    const m = story(mixed, 210);
    expect(m.figures.amount).toBe("USD 54");
    expect(m.figures.disputed).toBe("USD 88 disputed");
  });

  it("item 4: an id that is not an amount is never read as one", () => {
    const f = disputeRun(210);
    const fin = f.events.find((e) => e.kind === "step_finished")!;
    (fin.data!["ids"] as Record<string, string>)["dispute_amount"] = "88 or so";
    expect(story(f, 210).figures.amount).toBe("none");
  });

  it("item 5: one step reads as one step", () => {
    expect(story(disputeRun(210), 210).headline).toBe("The step is done.");
    expect(story(disputeRun(150), 150).headline).toBe("The step was sent.");
    expect(story(tinyBakery(40), 40).headline).toBe("All 5 steps done.");
  });

  // R-054: the lag line states what was measured (about 3 minutes twice, 12 hours once), not a ceiling.
  it("item 8: a dispute webhook not seen says how late the sandbox has delivered one, and nothing more", () => {
    const s = story(disputeRun(210), 210);
    expect(s.cards[0]!.reply).toBe("not-seen");
    expect(s.cards[0]!.lateNote).toBe(DISPUTE_LAG);
    expect(DISPUTE_LAG).toBe("In our sandbox runs, dispute events arrived about 3 minutes after filing, and once 12 hours later.");
    expect(s.lead).toContain(DISPUTE_LAG);
    // Said once, in place of the general line, never beside it.
    expect(s.lead!.split("12 hours").length).toBe(2);
    expect(s.lead).not.toContain("later than that before");
    expect(s.lead).not.toContain("up to 12 hours");
    // A run with no dispute never borrows the dispute measurement.
    const bakery = story(tinyBakery(40), 40);
    expect(bakery.cards.every((c) => c.lateNote === null)).toBe(true);
    expect(bakery.lead ?? "").not.toContain("12 hours");
  });

  it("knows the wait the run listens for: the plan's rule before it starts, the recorded seconds once it has", () => {
    // Before the wait: the shared rule, 270 s for a plan with a dispute, 90 s otherwise.
    expect(story(disputeRun(50, undefined, 270), 50).waitS).toBe(270);
    expect(story(tinyBakery(5), 5).waitS).toBe(90);
    // Once started, what the worker recorded wins, a deadline-shortened wait included.
    expect(story(disputeRun(150), 150).waitS).toBe(90);
    expect(story(disputeRun(150, undefined, 163), 150).waitS).toBe(163);
  });
});
