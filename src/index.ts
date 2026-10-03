#!/usr/bin/env node
// Entry point and composition root: wires the modules together and registers
// the MCP tools. Everything it calls lives in a lower layer
// (module/ -> service/ -> src/, with lib/ available to all), so this file is
// the only one that knows about all of them at once.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerAntigravityTool } from "../module/antigravity-tool.ts";
import { registerResumeTool } from "../module/resume-tool.ts";
import { detectCapabilities, probeModelCatalog } from "../service/capabilities.ts";
import { assertCatalogConsistency } from "../service/model-catalog.ts";

import {
  AGY_TIMEOUT_MS,
  NODE_TIMEOUT_MS,
  PRINT_TIMEOUT_ARG,
  RESUME_ON_TIMEOUT,
  RESUME_TIMEOUT_MS,
  TIMEOUT_IS_DEFAULT,
} from "./config.ts";
import {
  ENV_RESUME_ON_TIMEOUT,
  ENV_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.ts";
import { ensureLogDir, info } from "./logger.ts";
import { errorMessage } from "./types.ts";
import type { AgyCapabilities } from "./types.ts";

function announceReady(capabilities: AgyCapabilities): void {
  info(
    `pronto (agy ${capabilities.version ?? "indisponível"}, ` +
      `flags: ${[...capabilities.flags].join(" ") || "nenhuma"})`
  );
  info(
    `timeout efetivo: ${AGY_TIMEOUT_MS}ms ` +
      `(${PRINT_TIMEOUT_ARG}, backstop Node ${NODE_TIMEOUT_MS}ms, retomada ${RESUME_TIMEOUT_MS}ms; ` +
      `faixa aceita ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}ms, também por chamada via timeout_ms)` +
      `${TIMEOUT_IS_DEFAULT ? ` — padrão; ajuste com ${ENV_TIMEOUT_MS}` : ""}`
  );
  info(
    RESUME_ON_TIMEOUT
      ? "retomada automática: habilitada"
      : `retomada automática: desabilitada (use ${ENV_RESUME_ON_TIMEOUT}=true para habilitar)`
  );
}

async function main(): Promise<void> {
  await ensureLogDir();
  assertCatalogConsistency();

  const capabilities = await detectCapabilities();

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAntigravityTool(server, capabilities);
  registerResumeTool(server, capabilities);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  announceReady(capabilities);

  // Deliberately not awaited: drift reporting must not delay the handshake.
  if (capabilities.available) {
    void probeModelCatalog();
  }
}

main().catch((error: unknown) => {
  console.error("Erro no servidor MCP:", errorMessage(error));
  process.exit(1);
});
