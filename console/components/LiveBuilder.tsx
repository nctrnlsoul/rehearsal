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

export type PlanChoice = { readonly plan: string; readonly name: string; readonly summary: string; readonly description: string | null };
export type FinderChoice = { readonly id: string; readonly title: string };

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
async function post(route: "dry-run" | "plan" | "runs" | "finder", body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
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

export function LiveBuilder({ plans, finder }: { plans: readonly PlanChoice[]; finder: readonly FinderChoice[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"recorded" | "describe" | "finder">("recorded");
  const [finderClass, setFinderClass] = useState(finder[0]?.id ?? "");
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

  const findIt = async () => {
    setBusy("run");
    setProblem(null);
    const { status, json } = await post("finder", { classId: finderClass, confirm: true });
    if (status === 202 && typeof json["runId"] === "string") {
      router.push(`/live/${json["runId"]}`);
      return;
    }
    setBusy(null);
    setProblem(problemOf(status, json));
  };

  const runnable =
    mode === "finder" ? finderClass !== "" && busy === null : picked !== null && picked.dry.ok && picked.dry.sha256 !== null && busy === null;
  const chars = Array.from(description.trim()).length;

  return (
    <div className="builder">
      <section className="card pick" aria-labelledby="pick-h">
        <h2 id="pick-h"><span className="step-num" aria-hidden="true">1</span>Pick a plan</h2>
        <div className="seg modes" role="radiogroup" aria-label="Plan source">
          <button type="button" role="radio" aria-checked={mode === "recorded"} onClick={() => setMode("recorded")}>A recorded plan</button>
          <button type="button" role="radio" aria-checked={mode === "describe"} onClick={() => { setMode("describe"); setPicked(null); setProblem(null); }}>Describe a business</button>
          <button type="button" role="radio" aria-checked={mode === "finder"} onClick={() => { setMode("finder"); setPicked(null); setProblem(null); }}>Find an edge case</button>
        </div>
        {mode === "finder" ? (
          <fieldset className="plans">
            <legend className="sr">Finder classes</legend>
            {finder.map((c) => (
              <label key={c.id} className={`plan-option${finderClass === c.id ? " on" : ""}`}>
                <input type="radio" name="finder" value={c.id} checked={finderClass === c.id} onChange={() => setFinderClass(c.id)} />
                <span className="nm">{c.title}</span>
                <span className="id mono">{c.id}</span>
              </label>
            ))}
            <p className="note">One class per run. The model fills that class&apos;s fixed template (it may change values, never steps), the run reuses the store&apos;s webhook, and the verdict comes from the store&apos;s own records. 1 model call and 1 live run.</p>
          </fieldset>
        ) : mode === "recorded" ? (
          <fieldset className="plans">
            <legend className="sr">Recorded plans</legend>
            {plans.map((p) => (
              <label key={p.plan} className={`plan-option${chosen === p.plan ? " on" : ""}`}>
                <input type="radio" name="plan" value={p.plan} checked={chosen === p.plan} onChange={() => setChosen(p.plan)} />
                <span className="nm">{p.name}</span>
                <span className="sum">{p.summary}</span>
                {p.description !== null && <q>{p.description}</q>}
              </label>
            ))}
          </fieldset>
        ) : (
          <form className="describe" onSubmit={(e) => { e.preventDefault(); void planIt(); }}>
            <label htmlFor="desc">What does the business do? The model writes a plan; the schema, the hosted caps and the event target decide whether it may run.</label>
            <textarea id="desc" value={description} maxLength={DESCRIPTION_MAX} rows={4} onChange={(e) => setDescription(e.target.value)} placeholder="A candle shop that takes card orders and sometimes refunds one" />
            <div className="row-end">
              <span className="note mono">{chars} / {DESCRIPTION_MAX}</span>
              <button type="submit" className="btn btn-quiet" disabled={chars === 0 || busy !== null}>{busy === "plan" ? "Planning…" : "Write a plan (1 model call)"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="card dry" aria-labelledby="dry-h" aria-live="polite" aria-busy={busy !== null}>
        <h2 id="dry-h"><span className="step-num" aria-hidden="true">2</span>Read exactly what it will do</h2>
        {busy === "dry" && <p className="note">Checking the plan…</p>}
        {problem !== null && (
          <p className="problem-line"><Mark kind="bug">{problem.text}</Mark>{problem.link !== undefined && <> <Link href={problem.link.href}>{problem.link.label}</Link></>}</p>
        )}
        {picked === null && busy === null && problem === null && (
          <p className="note">{mode === "recorded" ? "Choose a plan." : mode === "describe" ? "Describe a business to get a plan." : "The finder plans its class when the run starts, so its exact steps show on the run's page."}</p>
        )}
        {picked !== null && (
          <>
            <p className="name">{picked.name}</p>
            {picked.dry.errors.length > 0 ? (
              <ul className="errors">{picked.dry.errors.map((e) => <li key={e}><Mark kind="bug">refused</Mark> {e}</li>)}</ul>
            ) : (
              <pre className="plan-lines mono">{picked.dry.lines.join("\n")}</pre>
            )}
            <dl className="facts">
              <dt>Worst-case time</dt><dd>{picked.dry.budgetS === null ? "not computed" : <>{picked.dry.budgetS} s of 600 s</>}</dd>
              <dt>Purchase bank</dt>
              <dd>{picked.dry.bank.needed === 0 ? "not used" : picked.dry.bank.short ? `BLOCKED: needs ${picked.dry.bank.needed}, ${picked.dry.bank.available} ready` : `draws ${picked.dry.bank.needed} of ${picked.dry.bank.available}`}</dd>
              <dt>Digest</dt>{picked.dry.sha256 === null ? <dd>none: the plan did not pass</dd> : <dd className="mono digest">{picked.dry.sha256}</dd>}
            </dl>
            {picked.scenario !== undefined && (
              <details className="json"><summary>The plan&apos;s JSON</summary><pre className="mono">{JSON.stringify(picked.scenario, null, 2)}</pre></details>
            )}
          </>
        )}
      </section>

      <section className="card go" aria-labelledby="go-h">
        <h2 id="go-h"><span className="step-num" aria-hidden="true">3</span>Run it live in the sandbox</h2>
        <button type="button" className="btn btn-primary" onClick={() => void (mode === "finder" ? findIt() : runIt())} disabled={!runnable} aria-describedby="go-note">
          {busy === "run" ? "Starting…" : mode === "finder" ? "Run this class" : "Run this exact plan"}
        </button>
        <p id="go-note" className="note">
          {mode === "finder" ? (
            "Runs the one class chosen above."
          ) : runnable ? (
            <>Sends the plan id and digest <span className="mono">{picked!.dry.sha256!.slice(0, 12)}</span>. The server reloads the plan and refuses if anything differs.</>
          ) : (
            "Enabled once the plan above passes every check."
          )}
        </p>
      </section>
    </div>
  );
}
