// Environment reading and validation, resolved once at module load so the
// startup banner and every later call agree on the same numbers.
import {
  DEFAULT_TIMEOUT_MS,
  ENV_RESUME_ON_TIMEOUT,
  ENV_SKIP_PERMISSIONS,
  ENV_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  NODE_GRACE_MS,
  RESUME_TIMEOUT_CAP_MS,
} from "./constants.ts";
import { info, warn } from "./logger.ts";

/**
 * The previous build hardcoded `--print-timeout=120s` under a 130s Node
 * backstop, so in practice *agy* always timed out first — every observed
 * "timeout waiting for response" in the activity log landed at ~124s wall
 * clock, never at 130s. Raising only the Node timeout would therefore have
 * changed nothing: both budgets have to move together, which is why
 * AGY_TIMEOUT_MS drives the CLI flag and the Node timeout is derived from it.
 */
export function resolveTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS) return parsed;
  warn(
    `${ENV_TIMEOUT_MS}='${raw}' inválido ` +
      `(esperado entre ${MIN_TIMEOUT_MS} e ${MAX_TIMEOUT_MS} ms); usando o padrão ${DEFAULT_TIMEOUT_MS}ms.`
  );
  return DEFAULT_TIMEOUT_MS;
}

/** agy parses Go durations; whole seconds are the safe common denominator. */
export function printTimeoutArg(ms: number): string {
  return `--print-timeout=${Math.ceil(ms / 1000)}s`;
}

/**
 * The two budgets that always move together: what agy is told, and the Node
 * backstop that must outlive it by the grace window (see NODE_GRACE_MS).
 * Built per call so a `timeout_ms` override replaces BOTH, never just one.
 */
export interface TimeoutBudget {
  readonly agyMs: number;
  readonly nodeMs: number;
  readonly printArg: string;
}

export function budgetFor(agyMs: number): TimeoutBudget {
  return { agyMs, nodeMs: agyMs + NODE_GRACE_MS, printArg: printTimeoutArg(agyMs) };
}

/** A resume re-enters finished work, so the automatic one is capped (see constants). */
export function autoResumeTimeoutMs(agyMs: number): number {
  return Math.min(agyMs, RESUME_TIMEOUT_CAP_MS);
}

/**
 * A resume is a full extra model turn (see attemptResume) — it does not read
 * a cache, it burns tokens. Defaulting that spend to "on" would surprise
 * whoever is watching cost, so the feature stays opt-in: anything other than
 * a literal "true" leaves it off.
 */
export function resolveBooleanFlag(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

const DEFAULT_BUDGET = budgetFor(resolveTimeoutMs(process.env[ENV_TIMEOUT_MS]));

/** Budget handed to agy itself, via --print-timeout. */
export const AGY_TIMEOUT_MS = DEFAULT_BUDGET.agyMs;

/** Node backstop: always AGY_TIMEOUT_MS plus the 10s grace window. */
export const NODE_TIMEOUT_MS = DEFAULT_BUDGET.nodeMs;

export const PRINT_TIMEOUT_ARG = DEFAULT_BUDGET.printArg;

export const RESUME_TIMEOUT_MS = autoResumeTimeoutMs(AGY_TIMEOUT_MS);

/**
 * Budget for ONE call: the per-call `timeout_ms` when given (announced on
 * stderr), otherwise the AGY_TIMEOUT_MS default. Nothing is stored, so an
 * override can never leak into the next call.
 */
export function resolveCallBudget(timeoutMs: number | undefined): TimeoutBudget {
  if (timeoutMs === undefined) return DEFAULT_BUDGET;
  const budget = budgetFor(timeoutMs);
  info(`timeout custom: ${timeoutMs}ms (${budget.printArg})`);
  return budget;
}

export const RESUME_ON_TIMEOUT = resolveBooleanFlag(process.env[ENV_RESUME_ON_TIMEOUT]);

/** True when the AGY_TIMEOUT_MS default is in force (drives the banner hint). */
export const TIMEOUT_IS_DEFAULT = !process.env[ENV_TIMEOUT_MS];

/**
 * Read at call time, not at load time, so the gate reflects the environment
 * the process is actually running under at the moment a command is built.
 * Single source of truth: every launch path asks this function rather than
 * re-testing the env var, so the opt-in cannot be honoured in one place and
 * skipped in another.
 */
export function skipPermissionsEnabled(): boolean {
  return process.env[ENV_SKIP_PERMISSIONS] === "true";
}
