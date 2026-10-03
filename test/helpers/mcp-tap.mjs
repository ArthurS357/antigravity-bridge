// Transparent stdio tap between an MCP client and the bridge: relays every
// newline-delimited JSON-RPC line unchanged in both directions and appends one
// JSONL record per line to $TAP_LOG, so test/measure.mjs can see the traffic
// the real client (claude -p) never shows: progress notifications, the
// progressToken it sent, notifications/cancelled, and who closed first.
//
//   node mcp-tap.mjs <server-entry.ts>
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [serverPath] = process.argv.slice(2);
const logPath = process.env.TAP_LOG;
const log = (rec) => logPath && appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...rec }) + "\n");

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"], env: process.env });

function relay(from, to, dir) {
  let buf = "";
  from.on("data", (chunk) => {
    to.write(chunk);
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        log({ dir, msg: JSON.parse(line) });
      } catch {
        log({ dir, raw: line });
      }
    }
  });
}

relay(process.stdin, child.stdin, "c2s");
relay(child.stdout, process.stdout, "s2c");

process.stdin.on("end", () => {
  log({ ev: "client-closed-stdin" });
  child.kill();
});
child.on("exit", (code, signal) => {
  log({ ev: "server-exit", code, signal });
  process.exit(code ?? 0);
});
