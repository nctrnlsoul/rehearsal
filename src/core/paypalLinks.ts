/**
 * Some PayPal endpoints return the created resource's id ONLY inside a HATEOAS
 * self link. Sandbox dispute creation is one: a 201 whose whole body is
 * {"links":[{"href":".../v1/customer/disputes/PP-R-DXC-10194171","rel":"self"}]}.
 *
 * Reading ids out of a link is worth its own tested function, because the
 * alternative is a gate that reports FAIL on a write that actually succeeded.
 */

function lastPathSegment(href: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter((p) => p !== "");
  const last = parts[parts.length - 1];
  if (last === undefined || last.trim() === "") return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** The id at the end of the `rel: "self"` link, or null. */
export function selfLinkId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const links = (body as Record<string, unknown>)["links"];
  if (!Array.isArray(links)) return null;

  for (const link of links) {
    if (typeof link !== "object" || link === null) continue;
    const rec = link as Record<string, unknown>;
    if (rec["rel"] !== "self") continue;
    const href = rec["href"];
    if (typeof href !== "string") continue;
    return lastPathSegment(href);
  }
  return null;
}
