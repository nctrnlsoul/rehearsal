import Link from "next/link";

export type Surface = "home" | "build" | "runs" | "finder" | "live" | "gate";

const NAV: ReadonlyArray<{ id: Surface; href: string; label: string }> = [
  { id: "home", href: "/", label: "Start here" },
  { id: "build", href: "/build", label: "Plans" },
  { id: "live", href: "/live", label: "Run live" },
  { id: "runs", href: "/runs", label: "Replays" },
  { id: "finder", href: "/finder", label: "Finder" },
];

/** The security line, exactly, on every page. */
export const SECURITY_LINE = "Sandbox only. Every write keyed and capped. No verdict without evidence.";

export function Topbar({ current }: { current: Surface }) {
  return (
    <header className="topbar">
      <div className="wrap">
        <Link className="brand" href="/">
          {/* Maker's mark: the NorthSchema blossom, ink on light (R-037). Not the product's logo. */}
          <img className="maker-mark" src="/northschema-blossom-ink.png" width={38} height={36} alt="Made by NorthSchema" />
          <span className="wordmark">Rehearsal</span>
        </Link>
        <nav aria-label="Rehearsal">
          {NAV.map((n) => (
            <Link key={n.id} href={n.href} aria-current={n.id === current ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="env-pill" title="Every call goes to api-m.sandbox.paypal.com, a literal in code">
          <Icon name="shield" />
          Sandbox only
        </span>
      </div>
    </header>
  );
}

/** Every page that shows recorded data says so, before anything else on the page. */
export function ReplayBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mode-strip replay-banner" role="note">
      <div className="wrap">
        <strong>REPLAY</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function LiveBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="mode-strip live live-banner" role="note">
      <div className="wrap">
        <strong>LIVE</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

/** The maker credit is text: the blossom does not go in a footer. */
export function SiteFooter() {
  return (
    <footer className="site">
      <div className="wrap">
        <span className="secline">{SECURITY_LINE}</span>
        <span className="maker">by NorthSchema</span>
      </div>
    </footer>
  );
}

export type MarkKind = "ok" | "bug" | "wait" | "stop";

/** State marks: an icon and a word, never color alone. */
export function Mark({ kind, children }: { kind: MarkKind; children: React.ReactNode }) {
  return (
    <span className={`mark ${kind}`}>
      <Icon name={kind === "ok" ? "check" : kind === "bug" ? "cross" : kind === "wait" ? "clock" : "dash"} />
      {children}
    </span>
  );
}

export function Badge({ kind, children }: { kind: MarkKind; children: React.ReactNode }) {
  return (
    <span className={`badge ${kind}`}>
      <Icon name={kind === "ok" ? "check" : kind === "bug" ? "cross" : kind === "wait" ? "clock" : "dash"} />
      {children}
    </span>
  );
}

export type IconName = "check" | "cross" | "clock" | "dash" | "shield" | "chevron" | "copy" | "arrow" | "dot";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const common = { viewBox: "0 0 16 16", "aria-hidden": true as const, className: className ?? "icon", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "check":
      return <svg {...common}><path d="M3.5 8.5l3 3 6-6.5" /></svg>;
    case "cross":
      return <svg {...common}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="8" cy="8" r="5.8" /><path d="M8 5v3.2l2 1.3" /></svg>;
    case "dash":
      return <svg {...common}><path d="M4 8h8" /></svg>;
    case "shield":
      return <svg {...common}><path d="M8 2l5 2v3.8c0 3-2.2 5.2-5 6.2-2.8-1-5-3.2-5-6.2V4z" /></svg>;
    case "chevron":
      return <svg {...common}><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>;
    case "copy":
      return <svg {...common}><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>;
    case "arrow":
      return <svg {...common}><path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" /></svg>;
    case "dot":
      return <svg {...common}><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" /></svg>;
  }
}
