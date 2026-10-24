import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { BudgetExceededError } from "../ai/budget";
import { UnsafeDescriptionError } from "../ai/prompt";
import { printable } from "../ai/planner";
import { MissingCredentialError } from "../adapters/env";
import { TargetRefusedError } from "../core/eventTarget";
import { HostRefusedError } from "../core/host";

/**
 * Everything the MCP server sends passes through here. Tool results carry
 * scenario names, PayPal summaries, store refusal reasons and, from the SDK
 * itself, echoes of untrusted input such as an unknown tool's name. Any of
 * those can hold escape sequences or bidi overrides, and the calling model and
 * the terminal behind it both read the result.
 */

export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_ERROR_CHARS = 500;

/** Strips control and format characters line by line, keeping the line breaks, then caps the length. */
export function cleanOutputText(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  const cleaned = text
    .split("\n")
    // U+2028 and U+2029 are neither Cc nor Cf, but they break a line all the same.
    .map((line) => printable(line).replace(/[\u2028\u2029]/g, " ").trimEnd())
    .join("\n");
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, maxChars).join("")}\n[output truncated at ${maxChars} characters]`;
}

/** Cleans tool-result text and error messages in one outgoing JSON-RPC message. Never mutates it. */
export function sanitizeOutgoing(message: JSONRPCMessage): JSONRPCMessage {
  if ("result" in message && message.result !== null && typeof message.result === "object") {
    const content = (message.result as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      result: {
        ...message.result,
        content: content.map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string"
            ? { ...item, text: cleanOutputText((item as { text: string }).text) }
            : item,
        ),
      },
    } as JSONRPCMessage;
  }
  if ("error" in message && message.error !== null && typeof message.error === "object") {
    return {
      ...message,
      error: { ...message.error, message: cleanOutputText(String(message.error.message), MAX_ERROR_CHARS) },
    } as JSONRPCMessage;
  }
  return message;
}

/** Wraps a transport's send so no outgoing message skips the sanitizer. */
export function guardTransport<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(sanitizeOutgoing(message), options);
  return transport;
}

/**
 * The text a caller sees for a thrown error. Only error types whose messages
 * are built from names, counts and redacted targets pass through. Anything
 * else may carry a PayPal body or an environment value, so it becomes a
 * correlation id that matches a line on the server's stderr.
 */
export function safeErrorText(e: unknown, correlationId: string): string {
  if (e instanceof MissingCredentialError) {
    return `environment variable ${e.variableName} is missing or blank`;
  }
  if (
    e instanceof BudgetExceededError ||
    e instanceof UnsafeDescriptionError ||
    e instanceof TargetRefusedError ||
    e instanceof HostRefusedError
  ) {
    return e.message;
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `the call timed out (ref ${correlationId})`;
  }
  return `internal error, details withheld (ref ${correlationId})`;
}
