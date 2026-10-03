// Capability detection (F-11): which flags this build of agy actually has.
//
// agy self-updates (observed 1.0.0 -> 1.1.12 -> 1.1.13 inside a single
// session), so nothing here is assumed — every flag the bridge depends on is
// probed against `--help` at startup, and a missing one degrades the feature
// that needs it instead of failing at spawn time.
import { runAgy } from "../lib/process-runner.ts";
import {
  AGY_BIN,
  CATALOG_PROBE_TIMEOUT_MS,
  PROBED_FLAGS,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
  VERSION_MAX_BUFFER_BYTES,
} from "../src/constants.ts";
import { error, warn } from "../src/logger.ts";
import { isNodeError, errorMessage } from "../src/types.ts";
import type { AgyCapabilities, AgyFlag } from "../src/types.ts";
import { warnOnCatalogDrift } from "./model-catalog.ts";

/** Actionable guidance for a missing or unusable binary (F-06). */
export function unavailableMessage(failure: string | null): string {
  return [
    `Binário '${AGY_BIN}' não encontrado ou não executável.`,
    failure ? `Detalhe: ${failure}` : null,
    "Para corrigir:",
    "  1. Verifique se a CLI responde:  agy --version",
    "  2. Se não responder, registre o PATH:  agy install",
    "  3. Se não estiver instalada, instale o Antigravity e reabra o terminal",
    "     (no Windows o PATH costuma ficar em %LOCALAPPDATA%\\agy\\bin).",
    "Depois reinicie o servidor MCP para refazer a detecção de capacidades.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function detectCapabilities(): Promise<AgyCapabilities> {
  const empty: ReadonlySet<AgyFlag> = new Set<AgyFlag>();
  try {
    const [help, version] = await Promise.all([
      runAgy(["--help"], {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
      }),
      runAgy(["--version"], {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_MAX_BUFFER_BYTES,
      }).catch(() => ({ stdout: "", stderr: "" })),
    ]);

    const helpText = `${help.stdout}${help.stderr}`;
    const found = new Set<AgyFlag>(PROBED_FLAGS.filter((flag) => helpText.includes(flag)));

    const missing = PROBED_FLAGS.filter((flag) => !found.has(flag));
    if (missing.length > 0) {
      warn(
        `flags ausentes nesta versão do agy: ${missing.join(", ")}. ` +
          "O comportamento será degradado para as que existem."
      );
    }

    return {
      available: true,
      version: version.stdout.trim() || null,
      flags: found,
      failure: null,
    };
  } catch (cause: unknown) {
    const failure =
      isNodeError(cause) && cause.code === "ENOENT"
        ? "spawn ENOENT (não está no PATH)"
        : errorMessage(cause);
    error(unavailableMessage(failure));
    return { available: false, version: null, flags: empty, failure };
  }
}

/**
 * `agy models` hits the network and measured ~20s on a cold call, so it must
 * never sit on the startup path — that delay makes an MCP client give up on
 * the handshake. Run it after connect(), purely to report catalog drift.
 */
export async function probeModelCatalog(): Promise<void> {
  try {
    const { stdout } = await runAgy(["models"], {
      timeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER_BYTES,
    });
    // Lines look like "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)".
    const reported = stdout
      .split("\n")
      .map((line) => line.split("\t")[0]?.trim() ?? "")
      .filter((slug) => slug.length > 0 && !slug.includes(" "));
    warnOnCatalogDrift(reported);
  } catch {
    // Offline or slow: the static catalog stays authoritative.
  }
}
