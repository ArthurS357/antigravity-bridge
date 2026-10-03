// Reading agy's `--output-format json` envelope: parsing it, deciding whether
// it may be unwrapped at all, unwrapping the part the caller actually asked
// for, and rendering its token accounting.
import type { AgyEnvelope, AgyUsage } from "../src/types.ts";

export function parseEnvelope(raw: string | undefined): AgyEnvelope | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as AgyEnvelope;
  } catch {
    return null;
  }
}

/** Human-readable tail describing which conversation to resume. */
export function resumeHint(envelope: AgyEnvelope | null): string {
  return envelope?.conversation_id
    ? ` (retome com: agy --conversation ${envelope.conversation_id})`
    : "";
}

/**
 * The one status agy reports for a run that actually completed.
 *
 * Compared trimmed and case-insensitively: the value is a string owned by a
 * CLI that self-updates, and rejecting a correct run over whitespace or
 * casing would be the same silent-failure class this check exists to remove.
 */
const SUCCESS_STATUS = "SUCCESS";

/**
 * Whether an envelope may be unwrapped into an answer, or has to be reported
 * as an error instead.
 *
 * `reason` is always safe to show the caller: it is agy's own text plus this
 * bridge's guidance, never a fragment of the model output.
 */
export type EnvelopeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides whether agy actually did the work it was asked to do.
 *
 * TWO independent failure signals, because either one alone lets a broken run
 * through — both verified empirically against agy 1.2.5:
 *
 *   1. `status` — the documented branch. agy's own --print-timeout exits with
 *      `{"status":"ERROR","error":"timeout waiting for response"}`.
 *
 *   2. `denied_actions` — the undocumented one, and the reason this function
 *      exists at all. When print mode soft-denies a tool call it cannot prompt
 *      for, the envelope still reports SUCCESS with an empty response:
 *
 *        {"status":"SUCCESS","response":"","usage":{...},
 *         "denied_actions":[{"action":"command","display_name":"RunCommand"}]}
 *
 *      A status-only check passes that envelope straight through and the
 *      caller receives nothing wearing the face of a successful run. That is
 *      the failure this change is about: an MCP tool that reports a partial
 *      result as success teaches the orchestrator to stop trusting it, which
 *      is strictly worse than failing loudly.
 *
 * Emptiness is deliberately NOT judged here. The caller knows whether it is
 * unwrapping a primary answer or a resume, and the two need different wording.
 */
export function evaluateEnvelope(envelope: AgyEnvelope | null): EnvelopeVerdict {
  // No envelope means text mode, or output that did not parse. There is no
  // contract to check; the caller falls back to raw stdout/stderr.
  if (!envelope) return { ok: true };

  const status = envelope.status?.trim();
  if (status && status.toUpperCase() !== SUCCESS_STATUS) {
    // `error` carries the diagnosis when agy fills it in; the bare status is
    // still more useful than discarding the signal when it does not.
    return { ok: false, reason: envelope.error?.trim() || `status=${status}` };
  }

  const denied = envelope.denied_actions ?? [];
  if (denied.length > 0) {
    const names = [...new Set(denied.map((entry) => entry.action ?? entry.display_name ?? "?"))];
    return {
      ok: false,
      reason:
        `o agy negou automaticamente ${denied.length} ação(ões) de ferramenta ` +
        `(${names.join(", ")}) porque o modo headless não consegue pedir confirmação. ` +
        "A tarefa NÃO foi concluída. Libere as ações em permissions.allow do settings.json " +
        "da CLI (~/.gemini/antigravity-cli/settings.json) ou habilite AGY_SKIP_PERMISSIONS=true",
    };
  }

  return { ok: true };
}

/**
 * Partial-timeout marker, matched against agy's STDERR only.
 *
 * agy announces a print-mode timeout nowhere else: the envelope still says
 * `"status":"SUCCESS"`, carries no `error`, and `response` holds whatever the
 * model had produced when the turn was cut — sometimes empty, sometimes a
 * confident-looking paragraph that reads like a finished answer.
 *
 * The pattern is deliberately strict, because a false positive here is far
 * worse than the one in isTimeoutFailure: it would turn a genuinely COMPLETE
 * answer into an error. Three guards, each earning its place against a line
 * actually observed on this CLI:
 *
 *   1. Anchored on agy's own `[agy]` prefix, so nothing the model wrote can
 *      trigger it. This is also why it is never run against stdout — stdout
 *      is the envelope, and the envelope contains the model's prose. A task
 *      whose answer discusses timeouts must not fail because of its topic.
 *
 *   2. Requires "print timeout after", not a bare "timeout". agy prints
 *      `root agent idle; waiting for 1 background task(s) (bounded by
 *      --print-timeout)` on a run that SUCCEEDED — a loose /print.?timeout/
 *      would flag it, and the hyphen is the only thing separating the two.
 *
 *   3. Requires "with turn in progress", the clause that distinguishes a turn
 *      cut mid-flight from any other mention of the budget.
 *
 * Observed verbatim on agy 1.2.5:
 *   [agy] print timeout after 25s with turn in progress; returning partial output
 */
const AGY_PRINT_TIMEOUT = /\[agy\]\s+print timeout after\s+(\S+?)\s+with turn in progress/i;

/**
 * Returns the timeout budget agy reported (e.g. "25s", "3m0s") when the run
 * was cut mid-turn, or null when it ran to completion.
 *
 * Callers must treat a non-null result as a failed run REGARDLESS of how much
 * text came back: partial output that looks like an answer is the single most
 * expensive thing this bridge can return, because it is indistinguishable
 * from a finished one at the call site.
 */
export function detectPartialTimeout(stderr: string): string | null {
  const match = AGY_PRINT_TIMEOUT.exec(stderr);
  return match ? (match[1] ?? "?") : null;
}

/** The caller wants the answer, not the metadata around it. */
export function unwrapEnvelope(
  envelope: AgyEnvelope | null,
  stdout: string,
  stderr: string
): string {
  if (!envelope) return (stdout || stderr || "").trim();
  return envelope.structured_output !== undefined
    ? JSON.stringify(envelope.structured_output, null, 2)
    : (envelope.response ?? "").trim();
}

function firstNumber(...candidates: readonly (number | undefined)[]): number | undefined {
  return candidates.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

/**
 * Renders `input=… , output=… (total=…)` for a usage block.
 *
 * Returns null when the envelope carried no usable accounting at all, which
 * the caller reports as a warning rather than printing a line of question
 * marks. Partial data is still worth printing, so a missing individual field
 * degrades to "?" instead of discarding the fields that did arrive.
 *
 * Field naming has not been stable across the agy versions observed, so both
 * the input/output and prompt/completion spellings are accepted, and `total`
 * is derived from the parts when the CLI omits it.
 */
export function formatUsage(usage: AgyUsage | undefined): string | null {
  if (!usage) return null;

  const input = firstNumber(usage.input_tokens, usage.prompt_tokens);
  const output = firstNumber(usage.output_tokens, usage.completion_tokens);
  const total =
    firstNumber(usage.total_tokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);

  if (input === undefined && output === undefined && total === undefined) return null;

  const show = (value: number | undefined): string => (value === undefined ? "?" : String(value));
  return `input=${show(input)}, output=${show(output)} (total=${show(total)})`;
}
