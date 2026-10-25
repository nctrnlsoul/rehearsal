"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Mark } from "./chrome";

/**
 * Pick a recorded plan or describe a business, read the dry run, then run that
 * exact plan. The Run button sends only the plan's id and the digest shown
 * here; the server reloads the plan and refuses if the digest differs.
 */

export type PlanChoice = { readonly plan: string; readonly name: string; readonly description: string | null };

type DryRun = {
  ok: boolean;
  sha256: string | null;
  budgetS: number | null;
  lines: string[];
  errors: string[];
  bank: { needed: number; available: number; short: boolean };
};

type Picked = { source: "recorded" | "planned"; planId: string; name: string; dry: DryRun; scenario?: unknown };

type Problem = { text: string; link?: { href: string; label: string } };

const DESCRIPTION_MAX = 2000;

/** Only this console's own routes, which run every check; the type allows nothing else. */
async function post(route: "dry-run" | "plan" | "runs", body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // A body that is not JSON is reported by status alone.
  }
  return { status: res.status, json };
}

/** One sentence for any refusal, plus what still works. */
function problemOf(status: number, json: Record<string, unknown>): Problem {
  const error = typeof json["error"] === "string" ? json["error"] : null;
  if (status === 401) return { text: "Your session ended.", link: { href: "/gate", label: "Unlock the gate again" } };
  if (status === 409 && typeof json["activeRunId"] === "string") {
    return { text: error ?? "Another live run is going.", link: { href: `/live/${json["activeRunId"]}`, label: "Watch it" } };
  }
  const reasons = Array.isArray(json["reasons"]) ? json["reasons"].filter((r): r is string => typeof r === "string") : [];
  return { text: [error ?? `The console answered ${status}.`, ...reasons.slice(0, 3)].join(" ") };
}

export function LiveBuilder({ plans }: { plans: readonly PlanChoice[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"recorded" | "describe">("recorded");
  const [chosen, setChosen] = useState(plans[0]?.plan ?? "");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState<"dry" | "plan" | "run" | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    if (mode !== "recorded" || chosen === "") return;
    let live = true;
    setBusy("dry");
    setProblem(null);
    setPicked(null);
    void post("dry-run", { source: "recorded", planId: chosen }).then(({ status, json }) => {
      if (!live) return;
      setBusy(null);
      if (status !== 200) return setProblem(problemOf(status, json));
      setPicked({ source: "recorded", planId: chosen, name: plans.find((p) => p.plan === chosen)?.name ?? chosen, dry: json as unknown as DryRun });
    });
    return () => {
      live = false;
    };
  }, [mode, chosen, plans]);

  const planIt = async () => {
    setBusy("plan");
    setProblem(null);
    setPicked(null);
    const { status, json } = await post("plan", { description });
    setBusy(null);
    if (status !== 200) return setProblem(problemOf(status, json));
    const scenario = json["scenario"] as Record<string, unknown> | undefined;
    setPicked({
      source: "planned",
      planId: String(json["planId"]),
      name: typeof scenario?.["name"] === "string" ? scenario["name"] : "Your plan",
      dry: json["dryRun"] as DryRun,
      scenario,
    });
  };

  const runIt = async () => {
    if (picked === null || picked.dry.sha256 === null) return;
    setBusy("run");
    setProblem(null);
    const { status, json } = await post("runs", { source: picked.source, planId: picked.planId, sha256: picked.dry.sha256, confirm: true });
    if (status === 202 && typeof json["runId"] === "string") {
      router.push(`/live/${json["runId"]}`);
      return;
    }
    setBusy(null);
    setProblem(problemOf(status, json));
  };

  const runnable = picked !== null && picked.dry.ok && picked.dry.sha256 !== null && busy === null;
  const chars = Array.from(description.trim()).length;

  return (
    <div className="builder">
      <section className="pick" aria-labelledby="pick-h">
        <h2 id="pick-h" className="label">1 · Choose what to run</h2>
        <div className="modes" role="radiogroup" aria-label="Plan source">
          <button type="button" role="radio" aria-checked={mode === "recorded"} className={`speed${mode === "recorded" ? " on" : ""}`} onClick={() => setMode("recorded")}>A recorded plan</button>
          <button type="button" role="radio" aria-checked={mode === "describe"} className={`speed${mode === "describe" ? " on" : ""}`} onClick={() => { setMode("describe"); setPicked(null); setProblem(null); }}>Describe a business</button>
        </div>
        {mode === "recorded" ? (
          <fieldset className="plans">
            <legend className="sr">Recorded plans</legend>
            {plans.map((p) => (
              <label key={p.plan} className="plan-option">
                <input type="radio" name="plan" value={p.plan} checked={chosen === p.plan} onChange={() => setChosen(p.plan)} />
                <span className="nm">{p.name}</span>
                <span className="id mono">{p.plan}</span>
                {p.description !== null && <q>{p.description}</q>}
              </label>
            ))}
          </fieldset>
        ) : (
          <form className="describe" onSubmit={(e) => { e.preventDefault(); void planIt(); }}>
            <label htmlFor="desc">What does the business do? The model writes a plan; the schema, the hosted caps and the event target decide whether it may run.</label>
            <textarea id="desc" value={description} maxLength={DESCRIPTION_MAX} rows={4} onChange={(e) => setDescription(e.target.value)} placeholder="A candle shop that takes card orders and sometimes refunds one" />
            <div className="row">
              <span className="note mono">{chars} / {DESCRIPTION_MAX}</span>
              <button type="submit" className="btn btn-quiet" disabled={chars === 0 || busy !== null}>{busy === "plan" ? "Planning…" : "Write a plan (1 model call)"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="dry" aria-labelledby="dry-h" aria-live="polite" aria-busy={busy !== null}>
        <h2 id="dry-h" className="label">2 · Read exactly what it becomes</h2>
        {busy === "dry" && <p className="note">Checking the plan…</p>}
        {problem !== null && (
          <p className="problem"><Mark kind="stop">{problem.text}</Mark>{problem.link !== undefined && <> <Link href={problem.link.href}>{problem.link.label}</Link></>}</p>
        )}
        {picked === null && busy === null && problem === null && <p className="note">{mode === "recorded" ? "Choose a plan." : "Describe a business to get a plan."}</p>}
        {picked !== null && (
          <>
            <p className="name">{picked.name}</p>
            {picked.dry.errors.length > 0 ? (
              <ul className="errors">{picked.dry.errors.map((e) => <li key={e}><Mark kind="bug">refused</Mark> {e}</li>)}</ul>
            ) : (
              <pre className="plan-lines mono">{picked.dry.lines.join("\n")}</pre>
            )}
            <dl className="facts">
              <dt>Worst-case time</dt><dd>{picked.dry.budgetS === null ? <span className="word">not computed</span> : <>{picked.dry.budgetS} s <span className="word">of</span> 600 s</>}</dd>
              <dt>Purchase bank</dt>
              <dd className="word">{picked.dry.bank.needed === 0 ? "not used" : picked.dry.bank.short ? `BLOCKED: needs ${picked.dry.bank.needed}, ${picked.dry.bank.available} ready` : `draws ${picked.dry.bank.needed} of ${picked.dry.bank.available}`}</dd>
              <dt>Digest</dt>{picked.dry.sha256 === null ? <dd className="word">none: the plan did not pass</dd> : <dd className="mono">{picked.dry.sha256}</dd>}
            </dl>
            {picked.scenario !== undefined && (
              <details><summary>The plan's JSON</summary><pre className="mono json">{JSON.stringify(picked.scenario, null, 2)}</pre></details>
            )}
          </>
        )}
      </section>

      <section className="go" aria-labelledby="go-h">
        <h2 id="go-h" className="label">3 · Run that, and only that</h2>
        <button type="button" className="btn btn-primary" onClick={() => void runIt()} disabled={!runnable} aria-describedby="go-note">
          {busy === "run" ? "Starting…" : "Run this exact plan"}
        </button>
        <p id="go-note" className="note">
          {runnable ? <>Sends the plan id and digest <span className="mono">{picked!.dry.sha256!.slice(0, 12)}</span>. The server reloads the plan and refuses if anything differs.</> : "Enabled once the plan above passes every check."}
        </p>
      </section>
    </div>
  );
}
