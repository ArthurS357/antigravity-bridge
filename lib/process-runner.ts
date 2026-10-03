// The ONLY place in this codebase that spawns a process.
//
// Centralising it buys three things: the no-shell guarantee is enforced in a
// single reviewable spot rather than re-asserted at five call sites; the
// windowsHide/maxBuffer/timeout defaults cannot drift apart between callers;
// and the test suite gets one seam to redirect instead of a regex sweep over
// the whole tree (see test/helpers/build-test-server.mjs).
import { execFile } from "child_process";
import { mkdirSync } from "fs";
import { promisify } from "util";
import { AGY_BIN, ENV_CWD, NEUTRAL_CWD } from "../src/constants.ts";
import { warn } from "../src/logger.ts";

const execFileAsync = promisify(execFile);

export interface RunOptions {
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  /** Propagates MCP cancellation to the child (F-08). */
  readonly signal?: AbortSignal | undefined;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface Launch {
  readonly file: string;
  readonly argv: readonly string[];
}

/**
 * Resolves which executable actually runs. Production always answers with the
 * real `agy`; test/helpers/build-test-server.mjs rewrites the single return
 * statement below to point at the fake CLI, because `agy` cannot be shadowed
 * through PATH on Windows (Node's execFile does not resolve a .cmd shim).
 *
 * Keep the return statement on one line and byte-identical to what that
 * script matches — it fails loudly at build time if the anchor moves.
 */
function resolveLaunch(args: readonly string[]): Launch {
  return { file: AGY_BIN, argv: [...args] };
}

/**
 * Working directory the child is pinned to.
 *
 * agy discovers instructions from its cwd on its own — GEMINI.md, AGENTS.md
 * and .agents/rules/*.md are all read relative to it — so an inherited cwd
 * means whatever project the MCP client was launched from silently joins
 * every delegated prompt. Pinning it makes the inherited context a constant
 * instead of a property of where the orchestrator happened to be.
 *
 * Read at call time rather than at module load, so AGY_CWD reflects the
 * environment the process is actually running under (same discipline as
 * skipPermissionsEnabled).
 *
 * NOTE what this does NOT do: the user-global rules (~/.gemini/GEMINI.md) and
 * the global skills are loaded regardless of cwd, so they are unaffected.
 *
 * Returns undefined when the directory cannot be created, which leaves the
 * inherited cwd in place — degraded, but a spawn that still runs beats an
 * ENOENT on a directory this bridge invented.
 */
function resolveWorkingDirectory(): string | undefined {
  const override = process.env[ENV_CWD]?.trim();
  const target = override && override.length > 0 ? override : NEUTRAL_CWD;
  try {
    mkdirSync(target, { recursive: true });
    return target;
  } catch (cause: unknown) {
    warn(`não foi possível preparar o cwd '${target}'; herdando o do processo (${String(cause)})`);
    return undefined;
  }
}

/**
 * Runs agy with an argument ARRAY and never a shell.
 *
 * Two separate defenses, both required, and both depending on this function
 * staying the only launcher:
 *
 * 1. execFile with an argument array never touches a shell, so prompt content
 *    (quotes, &, |, %VAR%, etc.) can't be interpreted as syntax.
 * 2. Callers build every dynamic argument in the `--flag=value` form, which
 *    keeps a value that starts with "-" from being parsed as a flag by agy
 *    itself. Verified: `--print "--version"` makes agy print its version
 *    instead of treating it as the prompt, while `--print="--version"`
 *    correctly passes it through as text. Without this, a prompt could inject
 *    agy flags — including --dangerously-skip-permissions, which is
 *    deliberately gated behind an env var.
 *
 * Rejections are propagated untouched: promisify(execFile) attaches the
 * child's stdout/stderr to the error, and that output is where agy puts the
 * real diagnosis and the conversation_id (F-02).
 */
export async function runAgy(args: readonly string[], options: RunOptions): Promise<RunResult> {
  const { file, argv } = resolveLaunch(args);
  const cwd = resolveWorkingDirectory();
  const { stdout, stderr } = await execFileAsync(file, [...argv], {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    ...(cwd ? { cwd } : {}),
    // Suppress the console window Windows would otherwise flash (F-07).
    windowsHide: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { stdout, stderr };
}
