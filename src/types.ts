// Shared type vocabulary for the bridge. Lowest layer: imports nothing from
// the project, so every other module can depend on it without creating a
// cycle. The type predicates live here too — a predicate is inseparable from
// the type it narrows to.

/**
 * Node errors carry a `code` (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, ...),
 * and rejections from promisify(execFile) additionally carry the child's
 * captured output. That output is where agy puts the real diagnosis, so it
 * must never be discarded (F-02). Used for both child_process and fs errors.
 */
export interface NodeError extends Error {
  readonly code?: string | number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly killed?: boolean;
}

export function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Token accounting as reported by agy. Every field is optional because the
 * envelope is a contract owned by a CLI that self-updates, and the field
 * naming has not been stable across the versions observed — so both the
 * `input/output` and the `prompt/completion` spellings are accepted rather
 * than assuming one of them.
 */
export interface AgyUsage {
  readonly total_tokens?: number;
  /** Observed on agy 1.2.5; reported for accounting, never summed into total. */
  readonly thinking_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

/**
 * One tool call agy refused to run on its own.
 *
 * In print mode agy cannot prompt for confirmation, so it *soft-denies* the
 * call and keeps going (observed in cli.log as
 * `tool_confirmation_manager.go: Print mode: soft-denying tool confirmation`).
 * Verified against agy 1.2.5: the envelope that comes back still says
 * `"status":"SUCCESS"` — the denial is reported ONLY here and on stderr, which
 * is exactly why a status check alone cannot catch it.
 */
export interface AgyDeniedAction {
  /** Permission name, e.g. "command" or "read_file". */
  readonly action?: string;
  /** Tool label, e.g. "RunCommand", "ViewFile", "ListDir". */
  readonly display_name?: string;
}

/** Shape of the `--output-format json` envelope emitted by agy. */
export interface AgyEnvelope {
  readonly conversation_id?: string;
  readonly status?: string;
  readonly response?: string;
  readonly error?: string;
  readonly duration_seconds?: number;
  readonly num_turns?: number;
  readonly structured_output?: unknown;
  readonly usage?: AgyUsage;
  /** Non-empty when agy silently refused one or more tool calls. */
  readonly denied_actions?: readonly AgyDeniedAction[];
}

/** Flags this bridge probes for at startup (F-11). */
export type AgyFlag =
  | "--output-format"
  | "--json-schema"
  | "--disable-slash-commands"
  | "--model"
  | "--effort"
  | "--conversation";

export interface AgyCapabilities {
  readonly available: boolean;
  readonly version: string | null;
  readonly flags: ReadonlySet<AgyFlag>;
  /** Populated when the binary could not be executed at all (F-06). */
  readonly failure: string | null;
}

/** Discriminated union so an invalid model/effort pairing cannot be ignored. */
export type ModelArgs =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** `timedOut` lets the caller tell "ran out of time" from every other failure. */
export type ResumeOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly reason: string; readonly timedOut: boolean };

/**
 * Machine-readable body of a timeout failure, so a client can act on it
 * (e.g. call resume_conversation) without scraping the message text.
 * An alias, not an interface, for the same index-signature reason as
 * ToolTextResult.
 */
export type TimeoutDetails = {
  error: "timeout";
  elapsed_ms: number;
  conversation_id: string | null;
  resume_hint: string;
};

/**
 * The MCP tool result shape this server returns.
 *
 * Declared as a type alias rather than an interface on purpose: the SDK's
 * CallToolResult carries an `[x: string]: unknown` index signature, and only
 * object-literal *aliases* get an implicit index signature to match it. An
 * interface here fails to assign, with a diagnostic that points nowhere near
 * the real cause.
 */
export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: TimeoutDetails;
};
