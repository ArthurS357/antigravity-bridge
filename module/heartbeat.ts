// MCP progress heartbeat for long tool calls.
//
// Without it, a silent agy turn longer than the client's idle timeout is
// aborted by the CLIENT (30 min in Claude Code for stdio servers), the child is
// killed, and no envelope — so no conversation_id — ever comes back. A
// progress notification resets that clock and shows up in the client UI.
//
// Sent only when the client asked for progress with a progressToken, as the
// MCP spec requires; Claude Code always does (it passes `onprogress`).
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { HEARTBEAT_INTERVAL_MS } from "../src/constants.ts";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Starts reporting elapsed seconds — one notification right away, then every
 * HEARTBEAT_INTERVAL_MS — and returns the function that stops it. The caller
 * must stop it in a `finally`, or the interval outlives the call.
 */
export function startHeartbeat(extra: ToolExtra, budgetMs: number): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};

  const startedAt = Date.now();
  const limit = Math.ceil(budgetMs / 1000);
  const beat = (): void => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: elapsed, message: `agy em execução há ${elapsed}s (limite ${limit}s)` },
      })
      // A heartbeat that cannot be delivered (transport closing) is not a
      // reason to fail the call it is reporting on.
      .catch(() => {});
  };

  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}
