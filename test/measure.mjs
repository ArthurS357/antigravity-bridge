// Measures how long the REAL MCP client (claude -p) waits on a silent
// tools/call, with and without the bridge's progress heartbeat. The agy is the
// test double (FAKE_MODE=sleep), so a run costs a few Claude tokens, not agy's.
//
//   node test/measure.mjs t40:40
//   node test/measure.mjs t1900:1900 t1900nb:1900:noheartbeat
//   node test/measure.mjs idle:100:noheartbeat:CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=60000
//
// Scenario: name:seconds[:flag...] where flag is `noheartbeat` (control build
// whose heartbeat never sends) or NAME=value (env for the claude process).
// Env ANTIGRAVITY_DISABLE_HEARTBEAT=1 applies noheartbeat to every scenario.
// At the end, measure-* log dirs older than 7 days are deleted; --keep-logs skips that.
// Env CLAUDE_BIN overrides the claude executable. It MUST be a build that has
// the MCP idle timeout (2.1.286 does; the npm CLI 2.1.186 does not, and never
// cuts a silent call, which makes the no-heartbeat control meaningless). The
// desktop app bundles one under %APPDATA%\Claude\claude-code\<version>\*\claude.exe.
//
// Traffic goes through test/helpers/mcp-tap.mjs, which logs each JSON-RPC line
// with a timestamp; that log is the source for the heartbeat numbers.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildTestServer } from "./helpers/build-test-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = join(HERE, "helpers", "fake-agy.mjs");
const TAP = join(HERE, "helpers", "mcp-tap.mjs");
const GENERATED = join(HERE, ".generated");
const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000;
const SERVER_NAME = "agy";
const TOOL = `mcp__${SERVER_NAME}__run_antigravity_task`;
const MAX_TIMEOUT_MS = 3_600_000; // the tool's own ceiling
const MARGIN_S = 120; // server budget above the sleep, so only the client can cut

/** claude.cmd is a shim Node cannot spawn directly (EINVAL); find the .exe behind it. */
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return exe;
    if (existsSync(join(dir, "claude.exe"))) return join(dir, "claude.exe");
  }
  throw new Error("claude.exe not found on PATH; set CLAUDE_BIN");
}

function parseScenario(arg) {
  const [name, secs, ...rest] = arg.split(":");
  const seconds = Number(secs);
  if (!name || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid scenario '${arg}', expected name:seconds[:noheartbeat|NAME=value...]`);
  }
  const env = {};
  let noHeartbeat = process.env.ANTIGRAVITY_DISABLE_HEARTBEAT === "1";
  for (const flag of rest) {
    if (flag === "noheartbeat") noHeartbeat = true;
    else if (flag.includes("=")) env[flag.slice(0, flag.indexOf("="))] = flag.slice(flag.indexOf("=") + 1);
    else throw new Error(`invalid flag '${flag}' in '${arg}'`);
  }
  return { name, seconds, noHeartbeat, env };
}

const builds = new Map(); // one test build per variant, shared across scenarios
const serverFor = (noHeartbeat) => {
  if (!builds.has(noHeartbeat)) builds.set(noHeartbeat, buildTestServer(FAKE_AGY, { noHeartbeat }));
  return builds.get(noHeartbeat).path;
};

function runClaude(claudeBin, args, env, hardLimitMs) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill(), hardLimitMs);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ stdout, stderr: stderr + String(e), code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Finds the tool_result of our tool in claude's stream-json output. */
function toolResult(stdout) {
  let found = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of ev.message?.content ?? []) {
      if (part.type !== "tool_result") continue;
      const text = Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("") : String(part.content ?? "");
      found = { isError: part.is_error === true, text };
    }
  }
  return found;
}

function analyzeTap(tapLog, startedAt) {
  const lines = existsSync(tapLog)
    ? readFileSync(tapLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const call = lines.find((l) => l.dir === "c2s" && l.msg?.method === "tools/call" && l.msg.params?.name === "run_antigravity_task");
  const progress = lines.filter((l) => l.dir === "s2c" && l.msg?.method === "notifications/progress");
  const cancelled = lines.filter((l) => l.dir === "c2s" && l.msg?.method === "notifications/cancelled");
  const gaps = progress.slice(1).map((p, i) => (p.t - progress[i].t) / 1000);
  return {
    sentAtS: call ? (call.t - startedAt) / 1000 : null,
    progressToken: call?.msg.params?._meta?.progressToken ?? null,
    heartbeats: progress.length,
    meanIntervalS: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    progressAtS: progress.map((p) => Math.round((p.t - startedAt) / 1000)),
    cancelled: cancelled.map((c) => ({ atS: (c.t - startedAt) / 1000, params: c.msg.params })),
    events: lines.filter((l) => l.ev).map((l) => ({ ev: l.ev, atS: (l.t - startedAt) / 1000 })),
  };
}

async function runScenario(claudeBin, scenario) {
  const { name, seconds, noHeartbeat, env } = scenario;
  const dir = join(GENERATED, `measure-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const tapLog = join(dir, "tap.jsonl");
  const timeline = join(dir, "timeline.jsonl");
  const timeoutMs = Math.min((seconds + MARGIN_S) * 1000, MAX_TIMEOUT_MS);

  const mcpConfig = join(dir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          command: process.execPath,
          args: [TAP, serverFor(noHeartbeat)],
          env: {
            TAP_LOG: tapLog,
            FAKE_MODE: "sleep",
            FAKE_SLEEP_MS: String(seconds * 1000),
            FAKE_TIMELINE_LOG: timeline,
          },
        },
      },
    })
  );

  const prompt =
    `Chame a ferramenta ${TOOL} uma única vez, com os argumentos exatos ` +
    `{"prompt":"dormir","timeout_ms":${timeoutMs}}. Não repita a chamada, mesmo que dê erro. ` +
    `Depois responda só com o texto retornado pela ferramenta.`;
  const args = [
    "-p", prompt,
    "--model", "haiku",
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpConfig, "--strict-mcp-config",
    "--allowedTools", TOOL,
    "--max-turns", "4",
  ];

  console.log(`\n[${name}] ${seconds}s, heartbeat ${noHeartbeat ? "OFF" : "on"}, env ${JSON.stringify(env)}`);
  const startedAt = Date.now();
  const run = await runClaude(claudeBin, args, env, (seconds + MARGIN_S + 300) * 1000);
  const wallS = (Date.now() - startedAt) / 1000;

  const tap = analyzeTap(tapLog, startedAt);
  const result = toolResult(run.stdout);
  const agyDone = existsSync(timeline) && readFileSync(timeline, "utf8").includes('"agy-done"');
  const completed = result !== null && !result.isError && agyDone;
  writeFileSync(join(dir, "claude-stdout.jsonl"), run.stdout);
  writeFileSync(join(dir, "claude-stderr.txt"), run.stderr);

  return { name, seconds, noHeartbeat, wallS, completed, agyDone, result, tap, dir, claudeCode: run.code, stderr: run.stderr };
}

function report(r) {
  const mean = r.tap.meanIntervalS === null ? "-" : `${r.tap.meanIntervalS.toFixed(1)}s`;
  console.log(`[${r.name}] wall ${r.wallS.toFixed(1)}s | ${r.completed ? "COMPLETOU" : "CORTOU/FALHOU"} | agy-done ${r.agyDone}`);
  console.log(`  progressToken enviado: ${JSON.stringify(r.tap.progressToken)} (tools/call a ${r.tap.sentAtS?.toFixed(1)}s)`);
  console.log(`  heartbeats: ${r.tap.heartbeats}, intervalo medio ${mean}, em [${r.tap.progressAtS.join(", ")}]s`);
  console.log(`  cancelled: ${r.tap.cancelled.length ? JSON.stringify(r.tap.cancelled) : "nenhum"}; eventos: ${JSON.stringify(r.tap.events)}`);
  if (!r.completed) {
    console.log(`  mensagem exata: ${r.result ? JSON.stringify(r.result.text) : `(sem tool_result) stderr: ${JSON.stringify(r.stderr.slice(0, 500))}`}`);
  }
  console.log(`  logs: ${r.dir}`);
}

/** Deletes measure-* dirs whose last write is older than the retention window. */
function pruneOldLogs() {
  if (!existsSync(GENERATED)) return 0;
  let removed = 0;
  for (const entry of readdirSync(GENERATED, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("measure-")) continue;
    const full = join(GENERATED, entry.name);
    if (Date.now() - statSync(full).mtimeMs <= LOG_RETENTION_MS) continue;
    rmSync(full, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

const keepLogs = process.argv.includes("--keep-logs");
const scenarios = process.argv.slice(2).filter((a) => a !== "--keep-logs").map(parseScenario);
if (!scenarios.length) {
  console.error("uso: node test/measure.mjs nome:segundos[:noheartbeat|NOME=valor] ...");
  process.exit(2);
}

const claudeBin = resolveClaude();
console.log(`claude: ${claudeBin} (${(await runClaude(claudeBin, ["--version"], {}, 30_000)).stdout.trim()})`);
const results = [];
for (const s of scenarios) {
  const r = await runScenario(claudeBin, s);
  report(r);
  results.push(r);
}

console.log("\n=== Resumo ===");
console.log("cenario".padEnd(12) + "sleep(s)".padStart(9) + "  hb   " + "parede(s)".padStart(10) + "  hbeats" + "  intervalo" + "  resultado");
for (const r of results) {
  const mean = r.tap.meanIntervalS === null ? "-" : `${r.tap.meanIntervalS.toFixed(1)}s`;
  console.log(
    r.name.padEnd(12) + String(r.seconds).padStart(9) + (r.noHeartbeat ? "  off  " : "  on   ") +
      r.wallS.toFixed(1).padStart(10) + String(r.tap.heartbeats).padStart(8) + mean.padStart(11) +
      "  " + (r.completed ? "completou" : "cortou/falhou")
  );
}
if (!keepLogs) {
  const removed = pruneOldLogs();
  if (removed) console.log(`\nlimpeza: ${removed} pasta(s) measure-* com mais de 7 dias removida(s) (--keep-logs desliga)`);
}
process.exit(results.every((r) => r.completed) ? 0 : 1);
