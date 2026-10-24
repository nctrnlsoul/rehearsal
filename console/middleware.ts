import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "./lib/csp";

/**
 * Sets the per-request CSP. Next reads the nonce from the request's own CSP
 * header and stamps it on the scripts it renders, so the policy and the page
 * always agree.
 */
export function middleware(req: NextRequest): NextResponse {
  const nonce = newNonce();
  // Exactly "development" relaxes the policy; anything else, including unset, is strict.
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development" });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Static chunks and fonts carry no HTML, so they need no policy of their own.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
