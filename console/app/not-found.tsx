import Link from "next/link";
import { SiteFooter, Topbar } from "../components/chrome";

export default function NotFound() {
  return (
    <div className="s-missing">
      <Topbar current="runs" />
      <main>
        <section className="hero" aria-labelledby="nf-h">
          <div className="wrap">
            <h1 id="nf-h">Nothing recorded here.</h1>
            <p className="lead">Only recorded runs replay, and this address is not one of them. <Link href="/runs">See the recorded runs</Link>.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
