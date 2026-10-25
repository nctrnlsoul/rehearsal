import type { CSSProperties } from "react";
import { Mark, SiteFooter, Topbar } from "../../components/chrome";
import "./gate.css";

const order = (i: number) => ({ "--i": i }) as CSSProperties;

type Query = { e?: string; left?: string; m?: string };

/** The state the last attempt left, from the redirect. Values are checked, never echoed raw. */
function stateOf(q: Query): { kind: "bug" | "wait" | "stop"; title: string; detail: string } | null {
  const n = (v: string | undefined, max: number) => (v !== undefined && /^\d{1,3}$/.test(v) ? Math.min(Number(v), max) : null);
  switch (q.e) {
    case "wrong": {
      const left = n(q.left, 5);
      return { kind: "bug", title: "That passcode did not match", detail: left === null ? "Try again." : `${left} ${left === 1 ? "try" : "tries"} left this hour from this address.` };
    }
    case "locked": {
      const m = n(q.m, 60);
      return { kind: "wait", title: "Locked after too many wrong tries", detail: `This address can try again in ${m ?? 60} min. Replays still work while you wait.` };
    }
    case "refused":
      return { kind: "stop", title: "That request was refused", detail: "It did not arrive as a post from this page. Reload the page and try again. Refused requests do not count as wrong tries." };
    case "closed":
      return { kind: "stop", title: "The gate is not configured", detail: "This deployment has no passcode set, so it stays shut. Replays still work." };
    default:
      return null;
  }
}

export default async function GatePage({ searchParams }: { searchParams: Promise<Query> }) {
  const state = stateOf(await searchParams);
  return (
    <div className="s-gate">
      <a className="skip" href="#gate">Skip to the passcode</a>
      <Topbar current="gate" />
      <main>
        <section className="behind arrive" style={order(0)} aria-labelledby="behind-h">
          <h1 id="behind-h">Behind this gate, a real PayPal sandbox account will run your scenario.</h1>
          <p className="lede">Every order, refund and webhook a live run starts is created for real in PayPal&apos;s sandbox and checked against our sample store. Nothing touches live PayPal or real money.</p>
        </section>
        <dl className="inside arrive" style={order(1)} aria-label="What is behind the gate">
          <dt>PayPal host</dt><dd><span className="mono">api-m.sandbox.paypal.com</span><small>pinned in code; no setting can point it at live PayPal</small></dd>
          <dt>Live runs</dt><dd>Arrive in Stage B<small>this deployment replays recorded runs only</small></dd>
          <dt>Per run</dt><dd><span className="mono">USD 2,000.00</span> at most, <span className="mono">USD 500.00</span> per step</dd>
          <dt>Without a passcode</dt><dd>Recorded runs replay, each one labeled REPLAY</dd>
        </dl>

        <section className="control arrive" style={order(2)} id="gate" aria-labelledby="gate-h">
          <div className="plate"><h2 id="gate-h" className="label">Unlock runs</h2><span className="label mono">01</span></div>
          <form method="post" action="/api/gate">
            <label htmlFor="passcode">Judge passcode</label>
            <input
              className="field" id="passcode" name="passcode" type="password" autoComplete="off" required maxLength={256}
              aria-describedby={state === null ? "pass-help" : "pass-help pass-state"} aria-invalid={state?.kind === "bug" ? "true" : undefined}
            />
            <p className="help" id="pass-help">It is in the private Devpost testing notes. It unlocks runs for 2 hours in this browser.</p>
            {state !== null && (
              <div className="status" id="pass-state" role="status">
                <Mark kind={state.kind}>{state.title}</Mark>
                <p>{state.detail}</p>
              </div>
            )}
            <button className="btn btn-primary" type="submit">Unlock</button>
          </form>
          <p className="after">Checked on the server against a hash; the passcode itself is stored nowhere. 5 wrong tries from one address (one /64 on IPv6) lock it out for an hour, counted by each server instance on its own.</p>
        </section>
      </main>
      <SiteFooter>REHEARSAL · judge gate</SiteFooter>
    </div>
  );
}
