// Minimal MCP stdio client: drives the bridge over the real protocol
// (initialize -> initialized -> tools/list -> tools/call) so tests exercise
// the actual transport, not a mocked shortcut around it.
import { spawn } from "node:child_process";

export function startServer(serverPath, env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const pending = new Map();
  /** Server-initiated notifications (no id), e.g. notifications/progress. */
  const notifications = [];

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined && msg.method) {
        notifications.push({ ...msg, receivedAt: Date.now() });
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on("data", (c) => (stderrBuf += c.toString()));

  let nextId = 1;

  /**
   * Sends a request and hands back its id alongside the promise, so a test
   * can cancel an in-flight call (notifications/cancelled needs the id).
   */
  const sendRequest = (method, params, timeoutMs = 120_000) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`client timeout esperando ${method}`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, promise };
  };

  const request = (method, params, timeoutMs = 120_000) =>
    sendRequest(method, params, timeoutMs).promise;

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return {
    child,
    request,
    sendRequest,
    notify,
    /** MCP cancellation: aborts the handler's `extra.signal` server-side. */
    cancel(requestId, reason = "cancelado pelo teste") {
      notify("notifications/cancelled", { requestId, reason });
    },
    /** Fires a tools/call without awaiting it, returning its request id. */
    callAsync(args, timeoutMs) {
      return sendRequest("tools/call", { name: "run_antigravity_task", arguments: args }, timeoutMs);
    },
    stderr: () => stderrBuf,
    async handshake() {
      const res = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-harness", version: "1.0.0" },
      });
      notify("notifications/initialized", {});
      return res;
    },
    call(args, timeoutMs) {
      return request("tools/call", { name: "run_antigravity_task", arguments: args }, timeoutMs);
    },
    /** tools/call for any tool by name (e.g. resume_conversation). */
    callTool(name, args, timeoutMs) {
      return request("tools/call", { name, arguments: args }, timeoutMs);
    },
    /** tools/call carrying a progressToken, as Claude Code always sends. */
    callWithProgress(name, args, progressToken, timeoutMs) {
      return request("tools/call", { name, arguments: args, _meta: { progressToken } }, timeoutMs);
    },
    notifications: () => [...notifications],
    /** Progress notifications received so far for `progressToken`. */
    progressFor(progressToken) {
      return notifications.filter(
        (n) => n.method === "notifications/progress" && n.params?.progressToken === progressToken
      );
    },
    stop() {
      child.kill();
    },
  };
}

export function waitForStderr(server, needle, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (server.stderr().includes(needle)) {
        clearInterval(tick);
        resolve(server.stderr());
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`stderr nunca conteve '${needle}'. Recebido:\n${server.stderr()}`));
      }
    }, 100);
  });
}
