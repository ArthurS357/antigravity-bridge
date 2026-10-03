// Produces a test build of the bridge that is byte-identical to production
// except for ONE seam: the process launcher. `agy` cannot be shadowed via
// PATH on Windows (Node's execFile does not resolve a .cmd shim), so the
// single `resolveLaunch` in lib/process-runner.ts is rewritten to spawn
// `node fake-agy.mjs ...` instead. Argument construction, timeout values,
// envelope parsing, timeout detection, and resume logic are all exercised
// unmodified — only the target binary changes.
//
// Before the refactor this script had to regex every `execFileAsync(AGY_BIN,
// ...)` call site in one 898-line file. Now that lib/process-runner.ts is the
// only launcher, exactly one line has to move, and the number of *callers*
// becomes an invariant the suite can assert on instead.
//
// The generated tree is written under the PACKAGE tree (test/.generated),
// not the OS temp dir: Node's ESM resolver walks up from the running file
// looking for node_modules, and a file under %TEMP% never finds the
// package's node_modules — every import of @modelcontextprotocol/sdk or zod
// fails with ERR_MODULE_NOT_FOUND. Living under the package root gets that
// walk-up for free. tsconfig.json excludes test/ so `tsc --noEmit` never
// type-checks these throwaway copies.
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATED_DIR = join(PACKAGE_ROOT, "test", ".generated");

/** The four source layers, copied verbatim into every test build. */
export const SOURCE_DIRS = ["src", "lib", "service", "module"];

const RUNNER_REL = join("lib", "process-runner.ts");
const ENTRY_REL = join("src", "index.ts");

/** Single line rewritten to redirect the launcher at the fake CLI. */
const LAUNCH_ANCHOR = "return { file: AGY_BIN, argv: [...args] };";

/** Early return of startHeartbeat; replaced only for the no-heartbeat control build. */
const HEARTBEAT_ANCHOR = "if (progressToken === undefined) return () => {};";
const HEARTBEAT_REL = join("module", "heartbeat.ts");

/** Every place that actually asks for a process to be spawned. */
const CALL_SITE = /\brunAgy\(/g;

function* walkTs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * @param {string} fakeAgyPath absolute path to test/helpers/fake-agy.mjs
 * @param {{ noHeartbeat?: boolean }} [options] noHeartbeat: control build whose
 *   startHeartbeat never sends anything (used by test/measure.mjs only)
 * @returns {{ path: string, dir: string, callSites: number }}
 */
export function buildTestServer(fakeAgyPath, { noHeartbeat = false } = {}) {
  const dir = join(GENERATED_DIR, randomUUID());
  mkdirSync(dir, { recursive: true });
  for (const source of SOURCE_DIRS) {
    cpSync(join(PACKAGE_ROOT, source), join(dir, source), { recursive: true });
  }

  // Count the callers, not the declaration: process-runner.ts is where runAgy
  // is defined, so counting it would inflate the total by one.
  let callSites = 0;
  for (const file of walkTs(dir)) {
    if (relative(dir, file) === RUNNER_REL) continue;
    callSites += (readFileSync(file, "utf8").match(CALL_SITE) ?? []).length;
  }

  const runnerPath = join(dir, RUNNER_REL);
  const runner = readFileSync(runnerPath, "utf8");
  if (!runner.includes(LAUNCH_ANCHOR)) {
    // A silent miss here would leave the tests talking to the REAL agy —
    // slow, non-deterministic, and quietly burning tokens. Fail at build time.
    throw new Error(
      `launch anchor not found in ${RUNNER_REL}; tests would hit the real agy. Expected: ${JSON.stringify(LAUNCH_ANCHOR)}`
    );
  }
  writeFileSync(
    runnerPath,
    runner.replace(
      LAUNCH_ANCHOR,
      `return { file: process.execPath, argv: [${JSON.stringify(fakeAgyPath)}, ...args] };`
    )
  );

  if (noHeartbeat) {
    const hbPath = join(dir, HEARTBEAT_REL);
    const hb = readFileSync(hbPath, "utf8");
    if (!hb.includes(HEARTBEAT_ANCHOR)) {
      throw new Error(`heartbeat anchor not found in ${HEARTBEAT_REL}; the control would still send progress`);
    }
    writeFileSync(hbPath, hb.replace(HEARTBEAT_ANCHOR, "return () => {}; // heartbeat disabled by measure harness"));
  }

  return { path: join(dir, ENTRY_REL), dir, callSites };
}
