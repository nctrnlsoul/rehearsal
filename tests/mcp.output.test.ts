import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "../src/ai/budget";
import { MissingCredentialError } from "../src/adapters/env";
import { TargetRefusedError } from "../src/core/eventTarget";
import { cleanOutputText, guardTransport, safeErrorText, sanitizeOutgoing } from "../src/mcp/output";

const NASTY = "a\u001b[31mred\u0007‮evil​zero\rcr\tb";

describe("cleanOutputText", () => {
  it("strips control and format characters but keeps line breaks", () => {
    const out = cleanOutputText(`${NASTY}\nsecond line`);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f​‮]/);
    expect(out).toContain("red");
    expect(out).toContain("evil");
  });

  it("caps the length by code point and says so", () => {
    const out = cleanOutputText("é".repeat(50), 10);
    expect(out).toBe(`${"é".repeat(10)}\n[output truncated at 10 characters]`);
  });
});

describe("sanitizeOutgoing", () => {
  it("cleans tool-result text", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: NASTY }, { type: "image", data: "x", mimeType: "image/png" }] },
    } as unknown as JSONRPCMessage;
    const out = sanitizeOutgoing(msg) as unknown as { result: { content: Array<{ text?: string; data?: string }> } };
    expect(out.result.content[0]!.text).not.toMatch(/[\u001b\u0007‮​\r\t]/);
    expect(out.result.content[1]!.data).toBe("x");
    // Never mutates the original.
    expect((msg as unknown as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe(NASTY);
  });

  it("cleans and caps a JSON-RPC error message", () => {
    const msg = { jsonrpc: "2.0", id: 2, error: { code: -32602, message: `${NASTY}${"z".repeat(2000)}` } } as JSONRPCMessage;
    const out = sanitizeOutgoing(msg) as unknown as { error: { message: string } };
    expect(out.error.message).not.toMatch(/[\u001b‮]/);
    expect(out.error.message.length).toBeLessThan(600);
  });

  it("leaves other messages alone", () => {
    const msg = { jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage;
    expect(sanitizeOutgoing(msg)).toBe(msg);
  });
});

describe("guardTransport", () => {
  it("routes every send through the sanitizer", async () => {
    const sent: JSONRPCMessage[] = [];
    const transport = {
      start: async () => {},
      close: async () => {},
      send: async (m: JSONRPCMessage) => {
        sent.push(m);
      },
    };
    guardTransport(transport);
    await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: NASTY }] } } as unknown as JSONRPCMessage);
    expect(JSON.stringify(sent[0])).not.toMatch(/\\u001b|‮/);
  });
});

describe("safeErrorText", () => {
  it("passes through messages built only from names and counts", () => {
    expect(safeErrorText(new MissingCredentialError("PAYPAL_SELLER_CLIENT_SECRET"), "r")).toBe(
      "environment variable PAYPAL_SELLER_CLIENT_SECRET is missing or blank",
    );
    expect(safeErrorText(new BudgetExceededError("calls-exhausted", "spent 6 of 6"), "r")).toBe("spent 6 of 6");
    expect(safeErrorText(new TargetRefusedError("not https", "x"), "r")).toBe("event target refused: not https");
  });

  it("withholds any other message behind a reference", () => {
    const text = safeErrorText(new Error("token body {access_token: abc}"), "deadbeef");
    expect(text).toBe("internal error, details withheld (ref deadbeef)");
  });

  it("reports a timeout as a timeout, without its message", () => {
    const e = new Error("aborted after reading secret");
    e.name = "TimeoutError";
    expect(safeErrorText(e, "r1")).toBe("the call timed out (ref r1)");
  });
});
