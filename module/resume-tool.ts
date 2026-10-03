// The resume_conversation tool: collects the answer a conversation already
// produced, on the caller's explicit request. It is the manual counterpart of
// the opt-in automatic resume (AGY_RESUME_ON_TIMEOUT) and deliberately does NOT
// go through recoverOrReport — a timeout here is reported, never retried, so
// the two paths cannot chain into a loop.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveCallBudget } from "../src/config.ts";
import { RESUME_TOOL_NAME } from "../src/constants.ts";
import { logActivity } from "../src/logger.ts";
import { textResult } from "../src/result.ts";
import type { AgyCapabilities } from "../src/types.ts";
import { unavailableMessage } from "../service/capabilities.ts";
import { fail, reportTimeout } from "../service/failure-report.ts";
import { attemptResume } from "../service/timeout-resume.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { buildResumeDescription, RESUME_TOOL_TITLE, resumeInputSchema } from "./schema.ts";

export function registerResumeTool(server: McpServer, capabilities: AgyCapabilities): void {
  const resumeSupported = capabilities.flags.has("--conversation");
  const envelopeMode = capabilities.flags.has("--output-format");
  const disableSlashCommands = capabilities.flags.has("--disable-slash-commands");

  server.registerTool(
    RESUME_TOOL_NAME,
    {
      title: RESUME_TOOL_TITLE,
      description: buildResumeDescription(capabilities),
      inputSchema: resumeInputSchema,
    },
    async ({ conversation_id, timeout_ms, json_output }, extra) => {
      if (!capabilities.available) return await fail(unavailableMessage(capabilities.failure));
      if (!resumeSupported) {
        return await fail("Esta versão do agy não expõe --conversation; atualize a CLI (agy update).");
      }

      const budget = resolveCallBudget(timeout_ms);
      const startedAt = Date.now();
      await logActivity(`🔁 RETOMADA EXPLÍCITA: ${conversation_id}`);

      // Not capped like the automatic resume: here the caller chose the budget,
      // up to 1h — past Claude Code's 30 min idle limit, hence the heartbeat.
      const stopHeartbeat = startHeartbeat(extra, budget.agyMs);
      const resumed = await attemptResume(conversation_id, {
        envelopeMode,
        disableSlashCommands,
        jsonSchema: undefined,
        jsonOutput: json_output,
        timeoutMs: budget.agyMs,
        signal: extra.signal,
      }).finally(stopHeartbeat);

      if (resumed.ok) {
        await logActivity(`✅ RETORNO (retomada de ${conversation_id}):\n${resumed.output}\n---`);
        return textResult(resumed.output);
      }

      const elapsed = Date.now() - startedAt;
      if (resumed.timedOut) {
        return await reportTimeout(
          `timeout após ${elapsed}ms ao retomar a conversa (motivo: ${resumed.reason}).`,
          elapsed,
          conversation_id
        );
      }
      return await fail(`Erro ao retomar a conversa ${conversation_id}: ${resumed.reason}`);
    }
  );
}
