// Plugin packaging checks: the committed bundle and the manifests must not
// drift from the source. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const fresh = execFileSync(process.execPath, [join(ROOT, "node_modules/esbuild/bin/esbuild"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(fresh === readFileSync(join(ROOT, "dist/server.mjs"), "utf8"), "bundle desatualizado");
});
