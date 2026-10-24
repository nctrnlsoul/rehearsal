import Link from "next/link";

export type Surface = "trust" | "build" | "runs" | "finder" | "live" | "gate";

const NAV: ReadonlyArray<{ id: Surface; href: string; label: string }> = [
  { id: "trust", href: "/", label: "Trust" },
  { id: "build", href: "/build", label: "Build" },
  { id: "runs", href: "/runs", label: "Replays" },
  { id: "finder", href: "/finder", label: "Finder" },
  { id: "live", href: "/live", label: "Live" },
];

export function Topbar({ current }: { current: Surface }) {
  return (
    <div className="topbar">
      <nav aria-label="REHEARSAL">
        <Link className="wordmark" href="/">REHEARSAL</Link>
        {NAV.map((n) => (
          <Link key={n.id} href={n.href} aria-current={n.id === current ? "page" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="env"><span className="label">Sandbox only</span> <span className="mono">api-m.sandbox.paypal.com</span></div>
    </div>
  );
}

/** Every page that shows recorded data says so, before anything else on the page. */
export function ReplayBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="replay-banner" role="note">
      <strong>REPLAY</strong>
      <span>{children}</span>
    </div>
  );
}

export function SiteFooter({ children }: { children: React.ReactNode }) {
  return <footer className="site">{children}</footer>;
}

/** State marks: a glyph and a word, never color alone. */
export function Mark({ kind, children }: { kind: "ok" | "bug" | "wait" | "stop"; children: React.ReactNode }) {
  const cls = kind === "stop" ? "wait" : kind;
  return (
    <span className={`mark ${cls}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {kind === "ok" && <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" />}
        {kind === "bug" && <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />}
        {kind === "wait" && (
          <>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" fill="none" />
            <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="2" fill="none" />
          </>
        )}
        {kind === "stop" && <path d="M3 8h10" stroke="currentColor" strokeWidth="2" />}
      </svg>
      {children}
    </span>
  );
}
