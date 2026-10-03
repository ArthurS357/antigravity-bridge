// Timeout recovery (F-12): recognising a timeout, finding the conversation to
// resume, and performing the single resume attempt.
import { runAgy } from "../lib/process-runner.ts";
import { buildResumeArgs } from "../src/args-builder.ts";
import { MAX_BUFFER_BYTES, NODE_GRACE_MS } from "../src/constants.ts";
import { info, logActivity, warn } from "../src/logger.ts";
import { errorMessage, isNodeError } from "../src/types.ts";
import type { AgyEnvelope, NodeError, ResumeOutcome } from "../src/types.ts";
import {
  detectPartialTimeout,
  evaluateEnvelope,
  formatUsage,
  parseEnvelope,
  unwrapEnvelope,
} from "./envelope.ts";

/**
 * Canonical UUID as printed in `conversation_id`. Used only as a fallback:
 * the envelope field is authoritative whenever the JSON parses, and matching
 * text is a last resort for a truncated or non-JSON failure.
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Deliberately narrow. A bare /timeout/ would also match a prompt about
 * timeouts echoed back in an unrelated error, and a false positive costs a
 * real agy call — so match the phrasings a timeout actually uses.
 *
 * "print timeout" was added after observing agy 1.2.5 report a timed-out run
 * as a SUCCESS envelope with an empty response, announcing it only on stderr:
 *   [agy] print timeout after 3m0s with turn in progress; returning partial output
 * Without this alternative that run is a silent failure AND is never resumed,
 * even though it leaves a perfectly good conversation_id behind.
 */
const TIMEOUT_TEXT = /timeout waiting|timed out|deadline exceeded|print timeout/i;

/**
 * Two distinct timeouts have to be recognised:
 *   - agy's own --print-timeout, which exits with
 *     `{"status":"ERROR","error":"timeout waiting for response", ...}`;
 *   - the Node backstop, which kills the child (killed/ETIMEDOUT) and leaves
 *     at most partial output.
 */
export function isTimeoutFailure(
  envelope: AgyEnvelope | null,
  failure: NodeError | null
): boolean {
  if (TIMEOUT_TEXT.test(`${envelope?.error ?? ""} ${envelope?.status ?? ""}`)) return true;
  if (failure?.killed === true || failure?.code === "ETIMEDOUT") return true;
  // Envelope mode is the norm, but a timeout can still arrive as plain text
  // (text output format, or JSON truncated mid-write).
  return TIMEOUT_TEXT.test(`${failure?.stderr ?? ""} ${failure?.stdout ?? ""}`);
}

export function extractConversationId(
  envelope: AgyEnvelope | null,
  ...raw: readonly (string | undefined)[]
): string | null {
  if (envelope?.conversation_id) return envelope.conversation_id;
  for (const chunk of raw) {
    const match = chunk?.match(UUID_PATTERN);
    if (match) return match[0];
  }
  return null;
}

/**
 * Reports what the resume actually cost.
 *
 * A resume is a full extra model turn, and it is the one spend this bridge
 * incurs that the caller never explicitly asked for — so it is accounted for
 * out loud, on stderr and in the activity log, rather than folded silently
 * into the answer. Only ever called on a resume that really ran and really
 * succeeded.
 */
async function reportResumeCost(envelope: AgyEnvelope | null): Promise<void> {
  const usage = formatUsage(envelope?.usage);
  if (usage === null) {
    warn("retomada sem dados de usage");
    await logActivity("⚠️ retomada sem dados de usage");
    return;
  }
  info(`retomada consumiu tokens: ${usage}`);
  await logActivity(`💰 retomada consumiu tokens: ${usage}`);
}

export interface ResumeOptions {
  readonly envelopeMode: boolean;
  readonly disableSlashCommands: boolean;
  readonly jsonSchema: string | undefined;
  readonly jsonOutput: boolean | undefined;
  /** What agy is told via --print-timeout; the Node backstop adds the grace window. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * One — and only one — attempt to collect the answer the timed-out call had
 * already produced. Runs through the same runAgy/array/`--flag=value`
 * discipline as the primary call: no shell, and the id can never be parsed
 * as a flag.
 *
 * Never retries and never resumes a resume: a timeout here is reported as
 * `timedOut`, and what to do about it is the caller's decision. That is what
 * keeps both the automatic path and the resume_conversation tool loop-free.
 */
export async function attemptResume(
  conversationId: string,
  options: ResumeOptions
): Promise<ResumeOutcome> {
  const args = buildResumeArgs({
    conversationId,
    envelopeMode: options.envelopeMode,
    disableSlashCommands: options.disableSlashCommands,
    jsonSchema: options.jsonSchema,
    jsonOutput: options.jsonOutput,
    timeoutMs: options.timeoutMs,
  });

  try {
    const { stdout, stderr } = await runAgy(args, {
      timeoutMs: options.timeoutMs + NODE_GRACE_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      signal: options.signal,
    });

    const envelope = parseEnvelope(stdout);
    // Same contract as the primary call: a resume whose tool calls were
    // soft-denied reports SUCCESS too, and must not be mistaken for a recovery.
    const verdict = evaluateEnvelope(envelope);
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, timedOut: isTimeoutFailure(envelope, null) };
    }

    // agy 1.2.15 still reports a cut turn as SUCCESS with the only evidence on
    // stderr (see detectPartialTimeout). A resume can be cut too, and its
    // partial text must not be returned as the recovered answer.
    const cutAfter = detectPartialTimeout(stderr);
    if (cutAfter !== null) {
      return { ok: false, reason: `retomada interrompida por timeout após ${cutAfter}`, timedOut: true };
    }

    const output = unwrapEnvelope(envelope, stdout, stderr);
    // An empty resume is a failure, not a successful empty answer — it means
    // the conversation could not be replayed.
    if (!output) return { ok: false, reason: "retomada retornou vazio", timedOut: false };

    await reportResumeCost(envelope);
    return { ok: true, output };
  } catch (cause: unknown) {
    const failure = isNodeError(cause) ? cause : null;
    const envelope = parseEnvelope(failure?.stdout);
    const detail = envelope?.error ?? (failure?.stderr ?? "").trim();
    // Cancellation also kills the child (`killed`), which isTimeoutFailure
    // would read as a timeout; the client stopping is not the clock running out.
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return {
      ok: false,
      reason: detail || errorMessage(cause),
      timedOut: !aborted && isTimeoutFailure(envelope, failure),
    };
  }
}
