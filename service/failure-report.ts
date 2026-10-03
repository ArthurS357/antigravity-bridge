// Turning a failed agy run into something the caller can act on — and
// deciding, for exactly one class of failure, whether to spend a resume on it.
import { RESUME_ON_TIMEOUT } from "../src/config.ts";
import { logActivity, warn } from "../src/logger.ts";
import { textResult, timeoutResult } from "../src/result.ts";
import { errorMessage } from "../src/types.ts";
import type { AgyEnvelope, NodeError, TimeoutDetails, ToolTextResult } from "../src/types.ts";
import { unavailableMessage } from "./capabilities.ts";
import { resumeHint } from "./envelope.ts";
import { attemptResume, extractConversationId, isTimeoutFailure } from "./timeout-resume.ts";

/** How much of a truncated stdout is echoed back to the caller. */
const TRUNCATED_PREVIEW_BYTES = 4000;

/** Every error path logs the same way before returning; do it in one place. */
export async function fail(message: string): Promise<ToolTextResult> {
  await logActivity(`❌ ERRO: ${message}\n---`);
  return textResult(message, true);
}

/**
 * A timeout failure with the structured body (see TimeoutDetails). Every
 * timeout that ends WITHOUT a recovered answer goes through here — the
 * automatic path and the resume_conversation tool alike — so the shape a
 * client sees is the same no matter which one gave up.
 */
export async function reportTimeout(
  message: string,
  elapsedMs: number,
  conversationId: string | null
): Promise<ToolTextResult> {
  const details: TimeoutDetails = {
    error: "timeout",
    elapsed_ms: elapsedMs,
    conversation_id: conversationId,
    resume_hint: conversationId
      ? `Use resume_conversation ou 'agy --conversation=${conversationId}'`
      : "Sem conversation_id, não há conversa para retomar; repita a tarefa com timeout_ms maior.",
  };
  const result = timeoutResult(message, details);
  await logActivity(`❌ ERRO: ${result.content[0]?.text ?? message}\n---`);
  return result;
}

/**
 * A cancellation that came from the MCP client (notifications/cancelled).
 *
 * Elapsed time and the client's reason are the only way to tell a user who
 * pressed Esc after seconds from a client-side timeout after many minutes —
 * the old one-line message could not. Also written to stderr, which is where
 * Claude Code keeps the server's log. The conversation_id is reported when it
 * exists, but in `--output-format json` agy only emits it at the very END, so
 * a call killed mid-turn normally has none.
 */
function describeClientCancel(
  envelope: AgyEnvelope | null,
  context: Pick<RecoveryContext, "startedAt" | "signal">
): string {
  const elapsed = Date.now() - context.startedAt;
  // A cancel without a reason leaves the runtime's default AbortError here,
  // whose "This operation was aborted" is not something the client said.
  const reason: unknown = context.signal?.reason;
  const reasonText =
    typeof reason === "string"
      ? reason
      : reason instanceof Error && reason.name !== "AbortError"
        ? reason.message
        : "";
  const message =
    `Execução cancelada pelo cliente MCP após ${elapsed}ms` +
    (reasonText.trim() ? ` (motivo do cliente: ${reasonText.trim()})` : "") +
    (envelope?.conversation_id
      ? `; conversation_id: ${envelope.conversation_id}`
      : "; sem conversation_id (o agy só o emite ao terminar).");
  warn(message);
  return message;
}

/**
 * `terminal` failures are reported as-is and must never reach the resume
 * logic; `recoverable` ones are handed to recoverOrReport, which decides
 * whether they are timeouts worth retrying.
 */
export type ExecutionFailure =
  | { readonly kind: "terminal"; readonly message: string }
  | { readonly kind: "recoverable"; readonly message: string };

/**
 * Classifies a rejection from the primary run.
 *
 * Cancellation and maxBuffer truncation both kill the child, which sets
 * `killed` — the same signal isTimeoutFailure reads. They are separated out
 * here so neither is mistaken for a timeout: a cancelled call must not be
 * resumed (the client already stopped caring), and a truncated one did not
 * run out of time.
 */
export function classifyExecutionError(
  error: unknown,
  failure: NodeError | null,
  envelope: AgyEnvelope | null,
  context: Pick<RecoveryContext, "startedAt" | "signal">
): ExecutionFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "terminal", message: describeClientCancel(envelope, context) };
  }

  if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    const partial = (failure.stdout ?? "").slice(0, TRUNCATED_PREVIEW_BYTES);
    return {
      kind: "terminal",
      message: `Saída do agy excedeu o maxBuffer e foi truncada. Início da saída:\n${partial}`,
    };
  }

  if (failure?.code === "ENOENT") {
    return { kind: "recoverable", message: unavailableMessage("spawn ENOENT durante a execução") };
  }

  if (envelope) {
    return {
      kind: "recoverable",
      message: `Erro no agy: ${envelope.error ?? envelope.status}${resumeHint(envelope)}`,
    };
  }

  const detail = (failure?.stderr ?? failure?.stdout ?? "").trim();
  return {
    kind: "recoverable",
    message: detail
      ? `Erro ao comunicar com o Antigravity (agy): ${detail}`
      : `Erro ao comunicar com o Antigravity (agy): ${errorMessage(error)}`,
  };
}

export interface RecoveryContext {
  /** Wall-clock start of the primary call, for the "timeout após Xms" text. */
  readonly startedAt: number;
  /** Whether this agy build exposes --conversation at all (F-11). */
  readonly resumeSupported: boolean;
  readonly envelopeMode: boolean;
  readonly disableSlashCommands: boolean;
  readonly jsonSchema: string | undefined;
  readonly jsonOutput: boolean | undefined;
  /** Budget for the automatic resume, derived from THIS call's timeout. */
  readonly resumeTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Shared by both failure paths, because a timeout can surface either way:
 * agy's own --print-timeout exits with an ERROR envelope, while the Node
 * backstop rejects with a killed child. Attempts the resume exactly once and
 * falls back to the original error plus manual instructions.
 */
export async function recoverOrReport(
  envelope: AgyEnvelope | null,
  failure: NodeError | null,
  baseMessage: string,
  context: RecoveryContext
): Promise<ToolTextResult> {
  if (!isTimeoutFailure(envelope, failure)) return await fail(baseMessage);

  const elapsed = Date.now() - context.startedAt;
  const conversationId = extractConversationId(envelope, failure?.stdout, failure?.stderr);

  // Opt-in gate checked before anything else: a disabled feature must never
  // spawn the resume process, regardless of whether the id or the capability
  // is available.
  if (!RESUME_ON_TIMEOUT) {
    return await reportTimeout(
      conversationId
        ? `timeout após ${elapsed}ms; retome manualmente com: agy --conversation ${conversationId}`
        : `${baseMessage} — timeout após ${elapsed}ms, sem conversation_id para retomada manual.`,
      elapsed,
      conversationId
    );
  }

  if (!conversationId) {
    return await reportTimeout(
      `${baseMessage} — sem conversation_id para retomar automaticamente (timeout após ${elapsed}ms).`,
      elapsed,
      null
    );
  }

  // Same discipline as every other flag here (F-11): don't spawn a process to
  // be told the flag doesn't exist.
  if (!context.resumeSupported) {
    return await reportTimeout(
      `${baseMessage} — retomada automática indisponível: esta versão do agy não expõe --conversation (timeout após ${elapsed}ms).`,
      elapsed,
      conversationId
    );
  }

  await logActivity(`⏱️ TIMEOUT após ${elapsed}ms; tentando retomar conversa ${conversationId}`);
  const resumed = await attemptResume(conversationId, {
    envelopeMode: context.envelopeMode,
    disableSlashCommands: context.disableSlashCommands,
    jsonSchema: context.jsonSchema,
    jsonOutput: context.jsonOutput,
    timeoutMs: context.resumeTimeoutMs,
    signal: context.signal,
  });

  if (resumed.ok) {
    await logActivity(`✅ RETORNO (retomada de ${conversationId}):\n${resumed.output}\n---`);
    return textResult(resumed.output);
  }

  return await reportTimeout(
    `timeout após ${elapsed}ms; tentativa de retomada falhou (motivo: ${resumed.reason}). ` +
      `Retome manualmente com: agy --conversation ${conversationId}`,
    elapsed,
    conversationId
  );
}
