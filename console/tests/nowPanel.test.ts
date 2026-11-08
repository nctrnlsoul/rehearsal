import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_REPLAYS, hostedById, hostedEndS, hostedRead } from "../lib/hostedReplays";
import type { LiveRead } from "../lib/liveView";
import { nowPanel, stagesOf } from "../lib/nowPanel";
import { runStory } from "../lib/runStory";
import { RUNS } from "../lib/replays";
import { type Fixture, absolute, disputeRun, recordedAt, tokenRefused } from "./fixtures/liveRuns";

const ID = "20261107230012-f3bb0a";
const hosted = hostedById(ID)!;
const at = (tS: number) => nowPanel(runStory(hostedRead(hosted, tS)));
const END = hostedEndS(hosted);

describe("the hosted replay's fixture", () => {
  it("is the evidence file, byte for byte", () => {
    const repo = join(__dirname, "..", "..");
    const evidence = readFileSync(join(repo, "evidence", `hosted-run-${ID}.json`));
    const fixture = readFileSync(join(__dirname, "..", "fixtures", `hosted-run-${ID}.json`));
    expect(fixture.equals(evidence)).toBe(true);
    expect(HOSTED_REPLAYS.map((h) => [h.runId, h.title, h.evidence])).toEqual([[ID, "Tiny Bakery, a hosted live run", `evidence/hosted-run-${ID}.json`]]);
  });

  it("ends at the row's own finish time and, there, serves the exported rows unchanged", () => {
    expect(END).toBeCloseTo(100.509, 2);
    const end = hostedRead(hosted, END);
    expect(end.events).toEqual(hosted.record.events);
    expect(end.run.status).toBe("complete");
    expect(end.run.finished_at).toBe(hosted.record.run.finished_at);
    expect(end.run.state).toEqual(hosted.record.run.state);
  });

  it("before the end, reads as running and holds no event from the future", () => {
    for (const t of [0, 3, 9, 20, 60]) {
      const r = hostedRead(hosted, t);
      expect(r.run.status).toBe("running");
      expect(r.run.finished_at).toBeNull();
      expect(r.run.state).toBeNull();
      const now = Date.parse(r.now);
      expect(r.events.every((e) => Date.parse(e.at) <= now)).toBe(true);
      expect(r.events.length).toBe(hosted.record.events.filter((e) => Date.parse(e.at) <= now).length);
    }
  });
});

describe("the Now running panel, on the hosted Tiny Bakery run", () => {
  it("shows the one call in flight, with its four stages", () => {
    const p = at(2);
    expect(p.key).toBe("step:card-order-1");
    expect(p.sticky).toBe(true);
    expect(p.body).toEqual({
      kind: "step",
      at: 1,
      of: 5,
      activity: "Capturing a card payment, USD 45",
      stages: [
        { label: "Sending to PayPal", short: "Sending", state: "now" },
        { label: "PayPal accepted", short: "Accepted", state: "todo" },
        { label: "Waiting for PayPal's webhook", short: "Webhook", state: "todo" },
        { label: "Signature verified", short: "Verified", state: "todo" },
      ],
      // A card capture is quick, so it gets no clock and no explaining line.
      note: null,
    });
    expect(p.label).toBe("0 of 5 accepted, 0 of 4 verified");
  });

  it("names an invoice step as the brief does, and a step with no event as having none", () => {
    const invoice = at(7.5);
    expect(invoice.key).toBe("step:invoice-1");
    expect(invoice.body.kind === "step" && invoice.body.activity).toBe("Creating the invoice, USD 120");
    expect(invoice.label).toBe("2 of 5 accepted, 0 of 4 verified");
    const send = at(8.5);
    expect(send.body.kind === "step" && send.body.activity).toBe("Sending the invoice");
    expect(send.body.kind === "step" && send.body.stages.slice(2).map((s) => s.state)).toEqual(["none", "none"]);
  });

  it("after the last call, waits on PayPal's webhooks with one chip per expected event", () => {
    const p = at(12);
    expect(p.key).toBe("webhooks");
    expect(p.label).toBe("5 of 5 accepted, 0 of 4 verified");
    expect(p.body.kind === "webhooks" && p.body.title).toBe("Waiting for PayPal's webhooks: 0 of 4 arrived");
    expect(p.body.kind === "webhooks" && p.body.chips.map((c) => [c.label, c.state])).toEqual([
      ["Step 1 payment", "out"],
      ["Step 2 payment", "out"],
      ["Step 3 invoice", "out"],
      ["Step 5 invoice paid", "out"],
    ]);
    const one = at(20);
    expect(one.body.kind === "webhooks" && one.body.title).toBe("Waiting for PayPal's webhooks: 1 of 4 arrived");
    expect(one.label).toBe("5 of 5 accepted, 1 of 4 verified");
    expect(one.body.kind === "webhooks" && one.body.chips[0]!.state).toBe("in");
  });

  it("once all four are in, says so and that the run is still listening", () => {
    const p = at(40);
    expect(p.body.kind === "webhooks" && p.body.title).toBe("All 4 webhooks arrived, 4 verified");
    expect(p.body.kind === "webhooks" && p.body.text).toMatch(/^The run keeps listening for 1m 0\ds in case PayPal sends more\.$/);
    expect(p.sticky).toBe(true);
  });

  it("settles into the final sentence and stops being sticky", () => {
    const p = at(END);
    expect(p.key).toBe("final");
    expect(p.sticky).toBe(false);
    expect(p.body).toEqual({
      kind: "final",
      tone: "done",
      title: "All 5 steps done.",
      text: "4 of 4 webhooks arrived, all verified.",
      note: "PayPal also sent 1 event not tied to a step by this console, listed below under Other events.",
      chips: expect.any(Array),
    });
    expect(p.label).toBe("5 of 5 accepted, 4 of 4 verified");
    expect(p.segments.map((s) => [s.sent, s.confirmed, s.expects])).toEqual([
      [true, true, true],
      [true, true, true],
      [true, true, true],
      [true, false, false],
      [true, true, true],
    ]);
  });

  // No fake progress: the counts only ever rise, and the box swaps in the run's own order.
  it("moves only on real state changes, in order, over the whole recorded clock", () => {
    let sent = 0;
    let confirmed = 0;
    const keys: string[] = [];
    const clock = [...Array.from({ length: Math.floor(END * 10) + 1 }, (_, i) => i / 10), END];
    for (const t of clock) {
      const p = at(t);
      const s = p.segments.filter((x) => x.sent).length;
      const c = p.segments.filter((x) => x.confirmed).length;
      expect(s).toBeGreaterThanOrEqual(sent);
      expect(c).toBeGreaterThanOrEqual(confirmed);
      expect(c).toBeLessThanOrEqual(s);
      sent = s;
      confirmed = c;
      if (keys.at(-1) !== p.key) keys.push(p.key);
    }
    expect(keys).toEqual(["queued", "step:card-order-1", "step:card-order-2", "step:invoice-1", "step:invoice-1-send", "step:invoice-1-payment", "webhooks", "final"]);
  });
});

describe("the hosted run's invoice events", () => {
  const story = runStory(hostedRead(hosted, END));

  it("join their invoice steps by the invoice id the store recorded", () => {
    const by = (id: string) => story.cards.find((c) => c.id === id)!;
    expect(by("invoice-1").replies.map((r) => [r.eventType, r.arrived])).toEqual([["INVOICING.INVOICE.CREATED", true]]);
    expect(by("invoice-1-payment").replies.map((r) => [r.eventType, r.arrived])).toEqual([["INVOICING.INVOICE.PAID", true]]);
    expect(by("invoice-1-send").reply).toBe("none-expected");
  });

  it("names the UNPAID event plainly, under Other events, by the invoice it shares with step 3", () => {
    expect(story.other).toEqual([
      expect.objectContaining({
        eventId: "WH-6F90236247748322J-4WR13669YJ8716204",
        eventType: "INVOICING.INVOICE.UNPAID",
        plain: "PayPal says the invoice is awaiting payment",
        related: [{ what: "invoice", id: "INV2-9V88-U4GQ-W3KB-Y4NY", steps: [3] }],
      }),
    ]);
  });
});

describe("the Now running panel, at the edges", () => {
  const T0 = Date.parse("2026-11-07T20:39:53Z");
  const readOf = (f: Fixture, status: string, nowS: number): LiveRead => ({
    run: {
      id: "20261107203953-bd8593",
      kind: "scenario",
      plan_source: "recorded",
      plan_id: "plan-20261023193216",
      scenario_sha256: null,
      status,
      state: null,
      halt_reason: f.reason ?? null,
      created_at: new Date(T0).toISOString(),
      started_at: new Date(T0).toISOString(),
      heartbeat_at: new Date(T0 + nowS * 1000).toISOString(),
      finished_at: status === "running" || status === "queued" ? null : new Date(T0 + nowS * 1000).toISOString(),
    },
    events: absolute(f, T0).map((e, i) => ({ ...e, seq: i + 1 })),
    now: new Date(T0 + nowS * 1000).toISOString(),
  });

  it("a halted run settles into the halted sentence, its step marked failed", () => {
    const f = tokenRefused();
    const p = nowPanel(runStory(readOf(f, "halted", 3)));
    expect(p.key).toBe("final");
    expect(p.sticky).toBe(false);
    expect(p.body.kind === "final" && [p.body.tone, p.body.title]).toEqual(["stopped", "Stopped at step 1."]);
    // The reason is the hero's lead; the panel never repeats it (audit 2026-11-07 evening: said three times).
    const s = runStory(readOf(f, "halted", 3));
    expect(s.lead).toBe("PayPal refused the seller app's login (its client id and secret do not match a sandbox app). Nothing was sent.");
    expect(p.body.kind === "final" && p.body.text).toBeNull();
    expect(p.segments[0]!.failed).toBe(true);
    // Steps that never ran expect nothing, so only the sent count is left to say.
    expect(p.label).toBe("0 of 5 accepted");
  });

  it("a queued run says so and fills nothing", () => {
    const p = nowPanel(runStory(readOf({ status: "queued", events: [] }, "queued", 1)));
    expect(p.key).toBe("queued");
    expect(p.segments).toEqual([]);
    expect(p.sticky).toBe(true);
  });
});

// The independent verifier's findings on the v0.7.1 diff, each held here.
describe("the Now running panel, after the verifier pass", () => {
  it("counts events and calls them verified, as the chips and the final sentence do; a refused copy is not counted", () => {
    const record = structuredClone(hosted.record) as typeof hosted.record;
    // A copy of the hosted rows with the first capture's delivery refused by the store's signature check.
    const events = record.events.map((e) => (e.kind === "delivery" && e.data["event_id"] === "WH-9NJ5058544606690H-55R672889N360970C" ? { ...e, data: { ...e.data, refused: 1 } } : e));
    const changed = { ...hosted, record: { ...record, events } };
    const p = nowPanel(runStory(hostedRead(changed, 40)));
    expect(p.label).toBe("5 of 5 accepted, 3 of 4 verified");
    expect(p.body.kind === "webhooks" && p.body.chips.map((c) => c.state)).toEqual(["bad", "in", "in", "in"]);
    expect(p.segments[0]!.confirmed).toBe(false);
  });

  it("makes no timing promise while it waits", () => {
    const p = at(12);
    expect(p.body.kind === "webhooks" && p.body.text).toBe("Each one turns to a check when it arrives and its signature is verified.");
  });

  it("before the plan is read, the hero and the panel both say the run is starting", () => {
    const s = runStory(hostedRead(hosted, 0));
    expect(s.cards).toEqual([]);
    expect([s.headline, s.lead, s.progress]).toEqual(["Starting.", "The server has picked it up. The first step starts in a moment.", null]);
    expect(nowPanel(s).body).toEqual({ kind: "queued", title: "Starting", text: "The server has picked it up. The first step starts in a moment." });
  });

  it("draws an unknown outcome as unknown, never as a refusal", () => {
    const card = runStory(hostedRead(hosted, END)).cards[0]!;
    for (const sent of ["unknown", "never-confirmed"] as const) {
      const stages = stagesOf({ ...card, sent, reply: "none", replies: [] });
      expect(stages.slice(0, 2).map((s) => [s.label, s.state])).toEqual([["Sending to PayPal", "unknown"], ["Outcome unknown", "unknown"]]);
      expect(stages.some((s) => s.state === "bad" || s.state === "done")).toBe(false);
    }
  });
});

// v0.7.4 item 2 (R-053): a step that sits at Sending for a minute must not look frozen.
describe("v0.7.4: the panel while PayPal works on a slow step", () => {
  const T0 = Date.parse("2026-11-08T03:30:57Z");
  const read = (f: Fixture, nowS: number): LiveRead => ({
    run: {
      id: "20261108033057-e2e0d1",
      kind: "scenario",
      plan_source: "recorded",
      plan_id: "plan-e2e",
      scenario_sha256: null,
      status: f.status,
      state: null,
      halt_reason: null,
      created_at: new Date(T0).toISOString(),
      started_at: new Date(T0).toISOString(),
      heartbeat_at: new Date(T0 + nowS * 1000).toISOString(),
      finished_at: f.status === "complete" ? new Date(T0 + nowS * 1000).toISOString() : null,
    },
    events: absolute(f, T0).map((e, i) => ({ ...e, seq: i + 1 })),
    now: new Date(T0 + nowS * 1000).toISOString(),
  });
  const panel = (f: Fixture, nowS: number) => nowPanel(runStory(read(f, nowS)));

  it("a resend shows its seconds on the Sending stage and the one line on why", () => {
    const p = panel(recordedAt(RUNS[1]!, 45), 45);
    if (p.body.kind !== "step") throw new Error(p.body.kind);
    expect(p.body.stages[0]!.label).toMatch(/^Sending to PayPal, 4\ds$/);
    expect(p.body.stages[0]!.short).toMatch(/^Sending, 4\ds$/);
    expect(p.body.stages[0]!.state).toBe("now");
    expect(p.body.note).toBe("PayPal lists a new event before it allows a resend. This usually takes 1 to 2 minutes.");
    // The box keeps its key while the clock moves, so it does not re-animate every second.
    expect(panel(recordedAt(RUNS[1]!, 50), 50).key).toBe(p.key);
  });

  it("a dispute shows the same, in its own words, past a minute", () => {
    const p = panel(disputeRun(91), 91);
    if (p.body.kind !== "step") throw new Error(p.body.kind);
    expect(p.body.stages[0]!.label).toBe("Sending to PayPal, 1m 30s");
    expect(p.body.note).toBe("PayPal creates the case, then makes it readable.");
  });

  it("item 5: one step and one webhook read in the singular", () => {
    const finished = panel(disputeRun(210), 210);
    if (finished.body.kind !== "final") throw new Error(finished.body.kind);
    expect(finished.body.title).toBe("The step is done.");
    expect(finished.body.text).toBe("0 of 1 webhook arrived before the run ended, 0 verified.");
  });
});
