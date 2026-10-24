import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteFooter, Topbar } from "../../components/chrome";
import { SESSION_COOKIE, hasValidSession } from "../../lib/session";
import "../gate/gate.css";

/**
 * Behind the gate. In Stage A there is nothing live to run, so the gate guards
 * only this notice; the session check is the same one Stage B's run route will use.
 */
export default async function LivePage() {
  const jar = await cookies();
  if (!hasValidSession(jar.get(SESSION_COOKIE)?.value, process.env, Date.now())) redirect("/gate");

  return (
    <div className="s-gate">
      <Topbar current="live" />
      <main style={{ display: "block", maxWidth: 760 }}>
        <h1>Live runs arrive in Stage B.</h1>
        <p className="lede">You are past the gate. This deployment does not run scenarios yet: it replays recorded runs of REHEARSAL&apos;s own sandbox account, each one labeled REPLAY.</p>
        <p className="lede">Stage B adds the run route: your plan executes in PayPal&apos;s sandbox within the same caps, and its timeline fills in live, with the honest waiting states you can see in the replays.</p>
        <p className="lede"><Link href="/runs">Open the recorded runs</Link> · <Link href="/finder">Open the finder&apos;s before and after</Link></p>
      </main>
      <SiteFooter>REHEARSAL · live (Stage A: nothing executes here)</SiteFooter>
    </div>
  );
}
