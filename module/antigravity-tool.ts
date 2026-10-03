// The run_antigravity_task tool: validates the request against what this agy
// build can do, spawns it with the call's own timeout budget, and turns the
// envelope into either the answer or an actionable failure.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runAgy } from "../lib/process-runner.ts";
import { buildEnhancedPrompt, buildPrimaryArgs } from "../src/args-builder.ts";
import { autoResumeTimeoutMs, resolveCallBudget } from "../src/config.ts";
import { MAX_BUFFER_BYTES, TOOL_NAME } from "../src/constants.ts";
import { logActivity } from "../src/logger.ts";
import { textResult } from "../src/result.ts";
import { isNodeError } from "../src/types.ts";
import type { AgyCapabilities, NodeError } from "../src/types.ts";
import { unavailableMessage } from "../service/capabilities.ts";
import {
  detectPartialTimeout,
  evaluateEnvelope,
  parseEnvelope,
  resumeHint,
  unwrapEnvelope,
} from "../service/envelope.ts";
import { classifyExecutionError, fail, recoverOrReport } from "../service/failure-report.ts";
import { buildModelArgs } from "../service/model-catalog.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { buildToolDescription, TOOL_TITLE, toolInputSchema } from "./schema.ts";

export function registerAntigravityTool(server: McpServer, capabilities: AgyCapabilities): void {
  const schemaSupported = capabilities.flags.has("--json-schema");
  const modelSupported = capabilities.flags.has("--model");
  const effortSupported = capabilities.flags.has("--effort");
  const resumeSupported = capabilities.flags.has("--conversation");
  const envelopeMode = capabilities.flags.has("--output-format");
  const disableSlashCommands = capabilities.flags.has("--disable-slash-commands");

  server.registerTool(
    TOOL_NAME,
    {
      title: TOOL_TITLE,
      description: buildToolDescription(capabilities),
      inputSchema: toolInputSchema,
    },
    async ({ prompt, context_files, json_output, json_schema, model, effort, timeout_ms }, extra) => {
      // Fail fast with instructions instead of a cryptic spawn error (F-06).
      if (!capabilities.available) return await fail(unavailableMessage(capabilities.failure));

      // Reject anything this agy build cannot do before spending a process on
      // being told the same thing (F-11).
      if (json_schema && !schemaSupported) {
        return await fail(
          "Esta versão do agy não expõe --json-schema; use json_output ou atualize a CLI (agy update)."
        );
      }
      if (model && !modelSupported) {
        return await fail(
          "Esta versão do agy não expõe --model; remova o parâmetro model ou atualize a CLI (agy update)."
        );
      }
      if (effort && !effortSupported) {
        return await fail(
          "Esta versão do agy não expõe --effort; remova o parâmetro effort ou atualize a CLI (agy update)."
        );
      }

      // Reject invalid model/effort pairings here so they cost nothing.
      const modelArgs = buildModelArgs(model, effort);
      if (!modelArgs.ok) return await fail(modelArgs.error);

      const enhancedPrompt = buildEnhancedPrompt({
        prompt,
        contextFiles: context_files,
        jsonOutput: json_output,
        jsonSchema: json_schema,
      });

      await logActivity(`🔄 ENVIADO: ${enhancedPrompt}`);

      // Per-call: a timeout_ms override replaces BOTH the --print-timeout and
      // the Node backstop for this call only (the backstop keeps its 10s grace).
      const budget = resolveCallBudget(timeout_ms);

      const args = buildPrimaryArgs({
        enhancedPrompt,
        capabilities,
        jsonSchema: json_schema,
        modelArgs: modelArgs.args,
        printTimeoutArg: budget.printArg,
      });

      const recovery = {
        startedAt: Date.now(),
        resumeSupported,
        envelopeMode,
        disableSlashCommands,
        jsonSchema: json_schema,
        jsonOutput: json_output,
        resumeTimeoutMs: autoResumeTimeoutMs(budget.agyMs),
        signal: extra.signal,
      };

      // Stopped in the finally below, which also covers an automatic resume.
      const stopHeartbeat = startHeartbeat(extra, budget.agyMs);
      try {
        const { stdout, stderr } = await runAgy(args, {
          timeoutMs: budget.nodeMs,
          maxBuffer: MAX_BUFFER_BYTES,
          signal: extra.signal,
        });

        const envelope = parseEnvelope(stdout);

        // agy exits 0 on runs it did not actually complete, so the exit code
        // decides nothing here — the envelope does. See evaluateEnvelope: it
        // catches both a non-SUCCESS status and a SUCCESS envelope whose tool
        // calls were silently denied.
        const verdict = evaluateEnvelope(envelope);
        if (!verdict.ok) {
          return await recoverOrReport(
            envelope,
            null,
            `Erro no agy: ${verdict.reason}${resumeHint(envelope)}`,
            recovery
          );
        }

        // A print-mode timeout is announced ONLY on stderr: the envelope still
        // reports SUCCESS and `response` holds whatever the model had written
        // when the turn was cut. That text is the dangerous case — it can read
        // like a finished answer, so it is discarded rather than returned.
        // Checked before unwrapping, so it covers partial output and empty
        // output alike, and routed through recoverOrReport because the
        // conversation is still alive and worth resuming.
        const timedOutAfter = detectPartialTimeout(stderr);
        if (timedOutAfter !== null) {
          const partial: NodeError = Object.assign(
            new Error(`print timeout after ${timedOutAfter}`),
            { stdout, stderr }
          );
          return await recoverOrReport(
            envelope,
            partial,
            `O agy foi interrompido por timeout após ${timedOutAfter} e devolveu apenas ` +
              "saída parcial, que foi descartada. A tarefa NÃO foi concluída.",
            recovery
          );
        }

        const output = unwrapEnvelope(envelope, stdout, stderr);

        // A run that produced nothing is a failure, not an empty success.
        // Returning a cheerful placeholder here is precisely what taught the
        // orchestrator that this tool "works" while handing back no answer.
        //
        // This is also how a timeout arrives on agy 1.2.5, which reports one as
        // a SUCCESS envelope with an empty response and puts the only evidence
        // on stderr ("print timeout after 3m0s ... returning partial output").
        // So the run is handed to recoverOrReport rather than failed outright:
        // the child exited cleanly, meaning there is no rejection carrying that
        // stderr, and isTimeoutFailure would otherwise never see it. Wrapping
        // the captured output in a NodeError gives the recovery path the same
        // evidence a real rejection would have carried, so a conversation that
        // can still be resumed is not thrown away.
        if (!output.trim()) {
          const detail = stderr.trim();
          const partial: NodeError = Object.assign(
            new Error(detail || "agy terminou sem produzir resposta"),
            { stdout, stderr }
          );
          return await recoverOrReport(
            envelope,
            partial,
            `O agy terminou sem produzir resposta.${detail ? ` Detalhe do agy: ${detail}` : ""}`,
            recovery
          );
        }

        const telemetry = envelope
          ? ` [${envelope.duration_seconds?.toFixed(1) ?? "?"}s, ${envelope.usage?.total_tokens ?? "?"} tokens]`
          : "";
        await logActivity(`✅ RETORNO${telemetry}:\n${output}\n---`);

        return textResult(output);
      } catch (error: unknown) {
        // On failure agy still writes the envelope to stdout, and the
        // promisified execFile attaches stdout/stderr to the rejection —
        // so the real cause and the conversation_id live here.
        const failure = isNodeError(error) ? error : null;
        const envelope = parseEnvelope(failure?.stdout);

        const classified = classifyExecutionError(error, failure, envelope, recovery);
        if (classified.kind === "terminal") return await fail(classified.message);

        return await recoverOrReport(envelope, failure, classified.message, recovery);
      } finally {
        stopHeartbeat();
      }
    }
  );
}
