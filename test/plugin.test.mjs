// Plugin packaging checks: the committed bundle and the manifests must not
// drift from the source. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "./helpers/mcp-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("plugin.json tem a mesma versão do package.json", () => {
  assert.equal(readJson(".claude-plugin/plugin.json").version, readJson("package.json").version);
});

test("dist/server.mjs é idêntico a um build novo (rode npm run build:plugin)", () => {
  // Same flags as the npm script, minus --outfile: esbuild then writes to stdout.
  const args = readJson("package.json")["scripts"]["build:plugin"]
    .split(" ")
    .slice(1)
    .filter((arg) => !arg.startsWith("--outfile="));
  // On Linux/macOS esbuild's install swaps bin/esbuild for its native binary (or
  // leaves a `#!/usr/bin/env node` script, which npm marks executable): run it
  // directly. Windows cannot exec a script, and there it is always the JS wrapper.
  const bin = join(ROOT, "node_modules/esbuild/bin/esbuild");
  const [file, argv] = process.platform === "win32" ? [process.execPath, [bin, ...args]] : [bin, args];
  const fresh = execFileSync(file, argv, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(fresh === readFileSync(join(ROOT, "dist/server.mjs"), "utf8"), "bundle desatualizado");
});

test("dist/server.mjs roda sozinho numa pasta vazia (sem node_modules nem src/)", async () => {
  // The plugin ships only the bundle; any import it failed to inline would crash here.
  const dir = mkdtempSync(join(tmpdir(), "antigravity-bridge-bundle-"));
  copyFileSync(join(ROOT, "dist/server.mjs"), join(dir, "server.mjs"));
  const server = startServer(join(dir, "server.mjs"));
  const died = new Promise((_, reject) =>
    server.child.once("exit", (code) => reject(new Error(`bundle saiu com código ${code}:\n${server.stderr()}`)))
  );
  died.catch(() => {}); // only observed through the race below
  try {
    const init = await Promise.race([server.handshake(), died]);
    assert.equal(init?.result?.serverInfo?.version, readJson("package.json").version, server.stderr());
    const tools = await Promise.race([server.request("tools/list", {}), died]);
    assert.deepEqual(
      tools?.result?.tools?.map((t) => t.name).sort(),
      ["resume_conversation", "run_antigravity_task"],
      server.stderr()
    );
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
