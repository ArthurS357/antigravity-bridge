// Diagnostics and the on-disk activity log.
//
// stdout belongs to the MCP stdio transport — writing anything there corrupts
// the protocol — so every human-facing line goes to stderr, always through
// the helpers below so the `[antigravity-bridge]` prefix stays uniform.
import { appendFile, stat, rename, mkdir } from "fs/promises";
import {
  LOG_DIR,
  LOG_FILE,
  LOG_FILE_PREVIOUS,
  LOG_PREFIX,
  MAX_LOG_BYTES,
} from "./constants.ts";
import { isNodeError, errorMessage } from "./types.ts";

/** Plain diagnostic line on stderr. */
export function info(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
}

/** Diagnostic that flags a degraded or unexpected condition. */
export function warn(message: string): void {
  console.error(`${LOG_PREFIX} aviso: ${message}`);
}

/** Diagnostic for a condition that already produced a user-visible error. */
export function error(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
}

/**
 * On a fresh install the directory may not exist yet, which would make every
 * single log write fail silently into stderr.
 */
export async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true }).catch((cause: unknown) => {
    error(`não foi possível criar ${LOG_DIR}: ${errorMessage(cause)}`);
  });
}

/**
 * Rolls the log over to `.1` once it exceeds MAX_LOG_BYTES, keeping exactly
 * one previous generation. Dependency-free on purpose: a logging concern is
 * not worth a new supply-chain surface on a bridge that runs unattended.
 */
async function rotateLogIfNeeded(): Promise<void> {
  try {
    const { size } = await stat(LOG_FILE);
    if (size < MAX_LOG_BYTES) return;
    await rename(LOG_FILE, LOG_FILE_PREVIOUS);
  } catch (cause: unknown) {
    // ENOENT simply means there is nothing to rotate yet.
    if (isNodeError(cause) && cause.code === "ENOENT") return;
    error(`falha ao rotacionar log: ${errorMessage(cause)}`);
  }
}

export async function logActivity(message: string): Promise<void> {
  await rotateLogIfNeeded();
  const timestamp = new Date().toISOString();
  // Logging is a diagnostic side-channel, not the tool's actual job — a
  // failed write here must never block or fail the agy call itself, so
  // report it to stderr instead of throwing.
  await appendFile(LOG_FILE, `[${timestamp}] ${message}\n`).catch((cause: unknown) => {
    error(`falha ao gravar log: ${errorMessage(cause)}`);
  });
}
