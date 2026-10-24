import Link from "next/link";
import { SiteFooter, Topbar } from "../components/chrome";
import "./gate/gate.css";

export default function NotFound() {
  return (
    <div className="s-gate">
      <Topbar current="runs" />
      <main style={{ display: "block", maxWidth: 760 }}>
        <h1>Nothing recorded here.</h1>
        <p className="lede">Only recorded runs replay, and this address is not one of them. <Link href="/runs">See the recorded runs</Link>.</p>
      </main>
      <SiteFooter>REHEARSAL · not found</SiteFooter>
    </div>
  );
}
