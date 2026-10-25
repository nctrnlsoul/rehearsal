import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../lib/body";

/** A chunked upload: a stream with no Content-Length, counting how much was pulled. */
function streamed(chunks: number, chunkBytes: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x41));
    },
  });
  const req = new Request("https://app.test/api/paypal/webhook", {
    method: "POST",
    body,
    // @ts-expect-error Node's fetch needs duplex for a streamed body; the DOM type omits it.
    duplex: "half",
  });
  return { req, pulled: () => pulled };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/paypal/webhook", { method: "POST", body, headers });

describe("readBodyCapped counts bytes, not characters (L6)", () => {
  it("refuses multibyte text over the cap in bytes, though under it in characters", async () => {
    // 600,000 characters, 1,200,000 bytes in UTF-8.
    expect(await readBodyCapped(post("é".repeat(600_000)), 1_000_000)).toBeNull();
  });

  it("accepts exactly the cap, and refuses one byte more", async () => {
    expect(await readBodyCapped(post("a".repeat(1000)), 1000)).toBe("a".repeat(1000));
    expect(await readBodyCapped(post("a".repeat(1001)), 1000)).toBeNull();
  });

  it("decodes UTF-8 that fits", async () => {
    expect(await readBodyCapped(post('{"note":"café"}'), 1000)).toBe('{"note":"café"}');
  });

  it("refuses a declared length over the cap without reading", async () => {
    const req = post("tiny", { "content-length": "5000000" });
    expect(await readBodyCapped(req, 1000)).toBeNull();
    expect(req.bodyUsed).toBe(false);
  });

  it("refuses a declared length that is not a number", async () => {
    expect(await readBodyCapped(post("tiny", { "content-length": "lots" }), 1000)).toBeNull();
  });

  it("stops reading a chunked upload as soon as it passes the cap", async () => {
    const s = streamed(1000, 64 * 1024);
    expect(await readBodyCapped(s.req, 1_000_000)).toBeNull();
    // 16 chunks of 64 KiB pass 1,000,000 bytes; nowhere near all 1000 are pulled.
    expect(s.pulled()).toBeLessThan(20);
  });

  it("reads a chunked upload that fits", async () => {
    const s = streamed(3, 10);
    expect(await readBodyCapped(s.req, 1000)).toBe("A".repeat(30));
  });
});
