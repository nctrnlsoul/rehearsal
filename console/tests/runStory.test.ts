import { describe, expect, it } from "vitest";
import type { LiveRead } from "../lib/liveView";
import { RUNS } from "../lib/replays";
import { type RunStory, dur, humanReason, money, runStory } from "../lib/runStory";
import { type Fixture, TOKEN_REFUSED_DETAIL, absolute, recordedAt, tinyBakery, tokenRefused } from "./fixtures/liveRuns";

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
    expect(later.cards[0]!.replies[0]!).toMatchObject({ plain: "PayPal confirmed: payment completed", rank: 1, exact: true });
    expect(Math.round(later.cards[0]!.replies[0]!.latencyS!)).toBe(12);
    expect(later.cards[2]!.replies[0]!).toMatchObject({ plain: "PayPal confirmed: invoice created", rank: 2 });
    expect(later.cards[1]!.reply).toBe("waiting");
    expect(Math.round(later.cards[1]!.waitingS!)).toBe(16);
  });

  it("says every step was sent, and how many events it still waits on, never that every step has run", () => {
    const s = story(tinyBakery(22), 22);
    expect(s.tone).toBe("waiting");
    expect(s.headline).toBe("All 5 steps sent.");
    expect(s.lead).toBe("Waiting on PayPal for 2 events. 2 of 4 confirmed so far.");
    expect(everything(s)).not.toMatch(/Every step has run/);
  });

  it("ends with the answer first, the proof in arrival order, and the unjoined event listed apart", () => {
    const s = story(tinyBakery(40), 40);
    expect(s.headline).toBe("All 5 steps done.");
    expect(s.lead).toBe("PayPal confirmed 4 of 4 events, every signature verified.");
    expect(s.proof.map((p) => `${p.label} ${dur(p.latencyS!)}`)).toEqual(["Payment 12s", "Invoice 12s", "Payment 20s", "Paid 16s"]);
    expect(s.figures).toEqual({ steps: "5 of 5", amount: "USD 345", amountNote: null, slowest: "20s", signatures: "5 of 5 passed", signaturesOk: true });
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

  it("counts a copy the store refused, so it never says every signature verified past one", () => {
    const f = tinyBakery(40);
    f.events.push({ s: 30, kind: "note", data: { refused_in_window: 1 } });
    const s = story(f, 41);
    expect(s.figures).toMatchObject({ signatures: "5 of 6 passed", signaturesOk: false });
    expect(s.lead).not.toMatch(/every signature/);
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
