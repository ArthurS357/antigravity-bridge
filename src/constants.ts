// Pure constants: no I/O, no env reads, no project imports beyond types.
// Anything that has to *interpret* the environment lives in config.ts.
import { join } from "path";
import { homedir, tmpdir } from "os";
import type { AgyFlag } from "./types.ts";

export const SERVER_NAME = "antigravity-bridge";
export const SERVER_VERSION = "1.9.0";

/** Prefix used on every stderr diagnostic this server emits. */
export const LOG_PREFIX = `[${SERVER_NAME}]`;

export const AGY_BIN = "agy";

export const TOOL_NAME = "run_antigravity_task";
export const RESUME_TOOL_NAME = "resume_conversation";

// --- Environment variable names -------------------------------------------
// Named here so a typo in one module cannot silently disable a feature.

export const ENV_TIMEOUT_MS = "AGY_TIMEOUT_MS";
export const ENV_RESUME_ON_TIMEOUT = "AGY_RESUME_ON_TIMEOUT";
export const ENV_SKIP_PERMISSIONS = "AGY_SKIP_PERMISSIONS";
/** Overrides the neutral working directory the child is pinned to. */
export const ENV_CWD = "AGY_CWD";
/** Overrides the activity-log directory; the test suite points it at test/.generated. */
export const ENV_LOG_DIR = "ANTIGRAVITY_LOG_DIR";

// --- Working directory -----------------------------------------------------

/**
 * Neutral directory the agy child is spawned in.
 *
 * Without this the child inherits whatever cwd the MCP client happened to
 * launch this server from, and agy discovers context from that directory on
 * its own: GEMINI.md, AGENTS.md and .agents/rules/*.md are all read relative
 * to the cwd. Whatever project the orchestrator was sitting in would silently
 * become part of every delegated prompt.
 *
 * Kept empty and stable so the inherited set is always the same one: the
 * user-global rules, which AGY_CWD cannot remove anyway. Anything the task
 * genuinely needs should arrive through the prompt or context_files, as
 * ABSOLUTE paths — relative ones no longer resolve against the caller's
 * project. Set AGY_CWD to opt back into a specific directory.
 */
export const NEUTRAL_CWD = join(tmpdir(), "antigravity-bridge-cwd");

// --- Timeouts --------------------------------------------------------------

/**
 * 10 min: real delegated work (code investigation, large refactors) routinely
 * outlives the 5 min this used to be, and a timeout throws the whole turn away.
 * agy itself now defaults headless runs to *unlimited* (0s), so the bridge's
 * budget is the only thing bounding a call.
 */
export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Accepted range for AGY_TIMEOUT_MS and the per-call `timeout_ms`. The floor
 * keeps a typo from producing a budget agy's own startup (~10s) cannot meet;
 * the ceiling is 1h. agy accepted `--print-timeout=999999s` without complaint
 * (agy 1.2.15), so the ceiling is this bridge's choice, not the CLI's.
 */
export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 3_600_000;

/**
 * Node must outlive agy's own timeout, otherwise the child is killed before
 * it can write the JSON envelope — and the envelope is the only place the
 * conversation_id exists. Killing early would destroy the very thing the
 * automatic resume depends on.
 */
export const NODE_GRACE_MS = 10_000;

/**
 * A resume re-enters a conversation whose work is already done, so it returns
 * far faster than the original call. Cap it so a second stall cannot double
 * the time the MCP client waits.
 */
export const RESUME_TIMEOUT_CAP_MS = 60_000;

/**
 * How often a running tool call reports progress to the MCP client.
 *
 * Claude Code (read from the 2.1.286 binary) aborts a stdio tool call that
 * sends "no response or progress notification" for 30 min — and checks that
 * every 30s — while timeout_ms goes up to 1h. Each progress notification
 * resets that idle clock. 30s keeps a call alive even if a user lowers
 * CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT to a minute.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Capability probes must never sit long on the startup path. */
export const PROBE_TIMEOUT_MS = 15_000;
/** `agy models` hits the network; measured ~20s cold. */
export const CATALOG_PROBE_TIMEOUT_MS = 30_000;

// --- Buffers and logs ------------------------------------------------------

/** Default is 1 MiB; a repo-wide analysis blows past it (F-01). */
export const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
export const PROBE_MAX_BUFFER_BYTES = 1024 * 1024;
export const VERSION_MAX_BUFFER_BYTES = 64 * 1024;

/** Rotate the activity log once it crosses this size (F-10). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

// homedir() resolves independent of which env vars a given spawn inherits.
// Read here rather than in config.ts: config.ts imports the logger, which
// imports this, so reading it there would close an import cycle.
export const LOG_DIR =
  process.env[ENV_LOG_DIR]?.trim() || join(homedir(), ".mcp-servers", "antigravity-bridge");
export const LOG_FILE = join(LOG_DIR, "mcp-activity.log");
export const LOG_FILE_PREVIOUS = `${LOG_FILE}.1`;

// --- Resume ----------------------------------------------------------------

/**
 * Verified against agy 1.1.13 and re-confirmed on 1.2.15: `--conversation=<id>`
 * on its own prints nothing (it opens an interactive session), so the resume
 * must carry a `--print` prompt. This one asks for the finished answer back
 * rather than new work. "Sem executar novas ferramentas" matters: resuming a
 * conversation that was cut mid-tool-call made the model retry the command,
 * which headless mode then soft-denied.
 */
export const RESUME_PROMPT =
  "Recupere a resposta final que você já produziu nesta conversa, " +
  "sem refazer o trabalho e sem executar novas ferramentas.";

// --- Capability probing ----------------------------------------------------

/**
 * Flags this bridge depends on. agy self-updates (observed 1.0.0 -> 1.1.12 in
 * a single session) and --disable-slash-commands is absent from the official
 * docs, so presence is verified at startup rather than assumed.
 */
export const PROBED_FLAGS = [
  "--output-format",
  "--json-schema",
  "--disable-slash-commands",
  "--model",
  "--effort",
  // Automatic timeout recovery depends on this one (F-12).
  "--conversation",
] as const satisfies readonly AgyFlag[];
