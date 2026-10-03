// Assembles the argv handed to lib/process-runner.
//
// INVARIANT enforced here: every argument whose value is not a compile-time
// literal uses the `--flag=value` form. execFile already removes the shell,
// but the `=` form is what stops a value beginning with "-" from being parsed
// as a flag by agy itself — without it a prompt could inject agy flags,
// including --dangerously-skip-permissions.
import { printTimeoutArg, skipPermissionsEnabled } from "./config.ts";
import { RESUME_PROMPT } from "./constants.ts";
import type { AgyCapabilities } from "./types.ts";

/** Control characters are stripped, never escaped — see buildEnhancedPrompt. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Shared by the task prompt and the resume prompt, so json_output means one thing. */
const JSON_FORMAT_NOTE =
  "\n\n[FORMATO] Responda exclusivamente com JSON válido, sem cercas markdown nem texto ao redor.";

export interface PromptOptions {
  readonly prompt: string;
  readonly contextFiles: readonly string[] | undefined;
  readonly jsonOutput: boolean | undefined;
  readonly jsonSchema: string | undefined;
}

/**
 * Appends the context/format preambles to the caller's prompt.
 *
 * context_files values are interpolated into the prompt, so a value carrying
 * newlines could forge its own instruction block. Paths never need control
 * characters — strip them rather than trusting the caller.
 */
export function buildEnhancedPrompt(options: PromptOptions): string {
  let enhanced = options.prompt;

  if (options.contextFiles && options.contextFiles.length > 0) {
    const safeFiles = options.contextFiles
      .map((file) => file.replace(CONTROL_CHARS, " ").trim())
      .filter((file) => file.length > 0);
    if (safeFiles.length > 0) {
      enhanced += `\n\n[CONTEXTO] Os seguintes arquivos já foram analisados: ${safeFiles.join(", ")}. Não utilize suas skills para lê-los novamente.`;
    }
  }

  // json_schema already forces structured output natively; the textual nudge
  // would only compete with it.
  if (options.jsonOutput && !options.jsonSchema) enhanced += JSON_FORMAT_NOTE;

  return enhanced;
}

export interface PrimaryArgsOptions {
  readonly enhancedPrompt: string;
  readonly capabilities: AgyCapabilities;
  readonly jsonSchema: string | undefined;
  /** Already built in the `=` form by service/model-catalog. */
  readonly modelArgs: readonly string[];
  /** This call's `--print-timeout=<N>s`, from resolveCallBudget. */
  readonly printTimeoutArg: string;
}

export function buildPrimaryArgs(options: PrimaryArgsOptions): readonly string[] {
  const args: string[] = [`--print=${options.enhancedPrompt}`, options.printTimeoutArg];

  if (options.capabilities.flags.has("--disable-slash-commands")) {
    args.push("--disable-slash-commands");
  }

  // --output-format json is what carries status, error text and
  // conversation_id. In text mode a failure writes nothing to stdout,
  // so there would be nothing to recover.
  if (options.capabilities.flags.has("--output-format")) {
    args.push("--output-format=json");
  }

  if (options.jsonSchema) {
    // Same `=` form: a schema path could legitimately begin with "-".
    args.push(`--json-schema=${options.jsonSchema}`);
  }

  args.push(...options.modelArgs);

  // Opt-in only, via the MCP server's own env config (not hardcoded):
  // this makes agy execute local tool actions with zero confirmation.
  // Any prompt that reaches this tool — including one relayed from
  // untrusted content elsewhere in a session — runs unattended.
  if (skipPermissionsEnabled()) {
    args.push("--dangerously-skip-permissions");
  }

  return args;
}

export interface ResumeArgsOptions {
  readonly conversationId: string;
  readonly envelopeMode: boolean;
  /** Whether this agy build exposes --disable-slash-commands (probed, like envelopeMode). */
  readonly disableSlashCommands: boolean;
  readonly jsonSchema: string | undefined;
  readonly jsonOutput: boolean | undefined;
  /** What agy is told; the caller adds the Node grace window on top. */
  readonly timeoutMs: number;
}

export function buildResumeArgs(options: ResumeArgsOptions): readonly string[] {
  const prompt = options.jsonOutput && !options.jsonSchema ? RESUME_PROMPT + JSON_FORMAT_NOTE : RESUME_PROMPT;
  const args: string[] = [
    `--conversation=${options.conversationId}`,
    `--print=${prompt}`,
    printTimeoutArg(options.timeoutMs),
  ];

  // The fixed RESUME_PROMPT has nothing to expand, so this changes no output
  // today; it is here so the resume runs under the same flag set as the
  // primary call. The flag is not inert in general — agy 1.2.16 warns that
  // it also neutralises --mode plan.
  if (options.disableSlashCommands) args.push("--disable-slash-commands");

  if (options.envelopeMode) args.push("--output-format=json");

  // Preserve the caller's structured-output contract: silently downgrading a
  // schema-bound request to free text would be worse than failing.
  if (options.jsonSchema) args.push(`--json-schema=${options.jsonSchema}`);

  // Unchanged opt-in: the resume gets exactly the permissions the original had.
  if (skipPermissionsEnabled()) args.push("--dangerously-skip-permissions");

  return args;
}
