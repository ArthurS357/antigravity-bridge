// The MCP result shape, in the lowest layer so both the tool contract
// (module/schema.ts) and the failure paths (service/failure-report.ts) can
// build one without either importing the other.
import type { TimeoutDetails, ToolTextResult } from "./types.ts";

export function textResult(text: string, isError = false): ToolTextResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * A timeout failure. The details travel twice on purpose: as
 * `structuredContent` for clients that read it, and as a JSON line at the end
 * of the text for the ones that only surface `content` (Claude Code does).
 */
export function timeoutResult(message: string, details: TimeoutDetails): ToolTextResult {
  return {
    content: [{ type: "text", text: `${message}\n${JSON.stringify(details)}` }],
    isError: true,
    structuredContent: details,
  };
}
