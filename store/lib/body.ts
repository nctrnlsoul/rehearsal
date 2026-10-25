/**
 * Reads a request body up to a cap counted in BYTES, as they arrive (audit
 * 2026-10-25 L6). The old check read the whole body first and then counted
 * UTF-16 characters, so a body of multibyte text could be twice the cap, and
 * a body of any size was held in memory before it was refused.
 *
 * A declared Content-Length over the cap is refused before reading. A chunked
 * upload declares none, so the count on the stream is what holds. Returns null
 * when the cap is passed; the rest of the stream is never read.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  if (req.body === null) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
