// The MCP tool contract: title, description, input schema, and the result
// shape. Kept apart from index.ts so the public surface of this server can be
// reviewed — and diffed — without wading through the orchestration around it.
import { z } from "zod";
import { AGY_TIMEOUT_MS, RESUME_ON_TIMEOUT } from "../src/config.ts";
import {
  DEFAULT_TIMEOUT_MS,
  ENV_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "../src/constants.ts";
import type { AgyCapabilities } from "../src/types.ts";
import { EFFORT_LEVELS, EFFORT_MODEL_NAMES, SELECTABLE_MODELS } from "../service/model-catalog.ts";

export const TOOL_TITLE = "Executar tarefa no Antigravity";
export const RESUME_TOOL_TITLE = "Retomar conversa do Antigravity";

/**
 * Shared by both tools. The bounds are enforced here, at the trust boundary:
 * a value outside them is rejected by the SDK as InvalidParams before any
 * process is spawned, rather than being silently clamped.
 */
const timeoutMsField = z
  .number()
  .int()
  .min(MIN_TIMEOUT_MS)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    "Timeout específico para esta chamada, em milissegundos. Se omitido, usa AGY_TIMEOUT_MS " +
      `(padrão ${DEFAULT_TIMEOUT_MS}). Aceita valores entre ${MIN_TIMEOUT_MS} e ${MAX_TIMEOUT_MS}.`
  );

/**
 * Raw Zod shape for the tool input. Exported as an object (not a z.object)
 * because McpServer.registerTool takes the shape and derives the JSON Schema
 * itself.
 */
export const toolInputSchema = {
  prompt: z.string().min(1).describe("A tarefa principal para o agy executar."),
  context_files: z
    .array(z.string().max(512))
    .max(100)
    .optional()
    .describe("Lista de arquivos já lidos por você. O agy não precisará usar a skill de leitura neles."),
  json_output: z
    .boolean()
    .optional()
    .describe("Se true, pede ao agy uma resposta em JSON. Para JSON garantido por schema, use json_schema."),
  json_schema: z
    .string()
    .optional()
    .describe("JSON Schema (string ou caminho de arquivo) que força saída estruturada nativa via --json-schema."),
  model: z
    .enum(SELECTABLE_MODELS)
    .optional()
    .describe(
      "Modelo do Antigravity. Se omitido, usa o default do IDE. Os slugs completos " +
        "(ex.: 'gemini-3.8-flash-high') já embutem o esforço e dispensam 'effort'. Os " +
        `nomes base (${EFFORT_MODEL_NAMES.map((name) => `'${name}'`).join(", ")}) ` +
        "exigem 'effort' — e 'gemini-3.1-pro' só aceita low|high. " +
        "Atenção a cotas: modelos gemini-* , claude-* e gpt-* consomem cotas separadas."
    ),
  effort: z
    .enum(EFFORT_LEVELS)
    .optional()
    .describe(
      "Nível de raciocínio. Válido sozinho (aplica ao modelo default) ou junto de um " +
        "nome base. Não pode ser combinado com um slug completo, que já embute o esforço."
    ),
  timeout_ms: timeoutMsField,
} as const;

export const resumeInputSchema = {
  conversation_id: z
    .string()
    .uuid()
    .describe("UUID da conversa a retomar, como devolvido no campo conversation_id de um timeout."),
  timeout_ms: timeoutMsField,
  json_output: z
    .boolean()
    .optional()
    .describe("Se true, pede ao agy que a resposta recuperada venha como JSON válido."),
} as const;

/**
 * The description is assembled from the *detected* capabilities, so a client
 * reading tools/list is told what this particular agy build can actually do
 * rather than what the bridge wishes it could do.
 *
 * Written for an ORCHESTRATOR deciding whether to spend a call, so it leads
 * with the two facts that decide that: the call blocks, and it starts from
 * zero context. Both were previously left implicit, and both are why the
 * tool was being reached for at the wrong moments.
 */
export function buildToolDescription(capabilities: AgyCapabilities): string {
  const resumeSupported = capabilities.flags.has("--conversation");

  return [
    "Delega uma tarefa autocontida a um agente Antigravity (agy) separado, que roda em",
    "outro processo, com contexto próprio e zero acesso a esta conversa.",

    "USE quando a tarefa for demorada ou volumosa e puder ser descrita por completo em",
    "um único prompt — análise de um conjunto de arquivos, geração de um artefato longo,",
    "uma segunda opinião independente. No Claude Code, várias chamadas despachadas no mesmo",
    "turno rodam UMA DE CADA VEZ (esta ferramenta não é somente-leitura): a espera total é a",
    "soma das durações, então junte numa chamada só o que couber num prompt.",

    "NÃO USE para: passos curtos que você mesmo faz mais rápido; qualquer coisa que",
    "dependa do histórico desta conversa (o agy não o enxerga); ou trabalho que precise",
    "de ida e volta — não existe sessão, cada chamada é independente.",

    "A CHAMADA BLOQUEIA até o agy terminar ou estourar o tempo. Não há job, handle nem",
    "polling: o retorno só chega no fim. Planeje o que fazer com a resposta ANTES de",
    "despachar, não enquanto ela roda.",

    "CONTRATO DE RETORNO: sucesso devolve apenas a resposta do agy, sem envelope. Erro,",
    "timeout, resposta vazia ou ferramenta negada em modo headless voltam como isError",
    "com o motivo — nunca como conteúdo parcial. Um retorno de sucesso significa que a",
    "tarefa foi concluída; trate isError como tarefa NÃO realizada.",

    "Passe em context_files (caminhos ABSOLUTOS) o que você já leu, para o agy não",
    "reler. O agy roda num diretório neutro, então caminhos relativos ao seu projeto",
    "não resolvem sozinhos — cite-os por completo no prompt.",

    `Limite de execução: ${Math.round(AGY_TIMEOUT_MS / 1000)}s (configurável via ${ENV_TIMEOUT_MS}; ` +
      "para uma tarefa que sabidamente demora mais, passe timeout_ms nesta chamada).",

    !RESUME_ON_TIMEOUT
      ? "Retomada automática desabilitada (AGY_RESUME_ON_TIMEOUT!=true); timeout devolve conversation_id (no texto e em structuredContent) para a ferramenta resume_conversation."
      : resumeSupported
        ? "Em caso de timeout com conversation_id, a conversa é retomada automaticamente uma vez (consome tokens extras)."
        : "Nota: esta versão do agy não expõe --conversation; não há retomada automática após timeout.",

    capabilities.available ? null : " INDISPONÍVEL: binário agy não encontrado nesta máquina.",
    capabilities.flags.has("--json-schema") ? null : " Nota: esta versão do agy não suporta json_schema.",
    capabilities.flags.has("--model") ? null : " Nota: esta versão do agy não suporta seleção de modelo.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

/**
 * Written for the moment right after a timeout: the orchestrator holds a
 * conversation_id and needs to know this is the cheap way to use it.
 */
export function buildResumeDescription(capabilities: AgyCapabilities): string {
  return [
    "Retoma uma conversa do agy pelo conversation_id e devolve a resposta final que ela já produziu,",
    "sem refazer o trabalho. Use depois de um timeout de run_antigravity_task, cujo erro traz o id.",

    "Só recupera trabalho que o agy chegou a CONCLUIR: um turno cortado pelo timeout no meio não",
    "continua, e a retomada então responde que nada foi produzido. Para tarefa longa, prefira repetir",
    "run_antigravity_task com timeout_ms maior.",

    "Custa um turno extra do modelo, e só acontece quando você chama — nunca é disparada sozinha.",
    "Se esta retomada também estourar o tempo, volta o mesmo erro estruturado de timeout; não há",
    "retomada automática encadeada.",

    `Limite: ${Math.round(AGY_TIMEOUT_MS / 1000)}s por padrão (${ENV_TIMEOUT_MS}); ajuste com timeout_ms.`,

    capabilities.flags.has("--conversation")
      ? null
      : "INDISPONÍVEL: esta versão do agy não expõe --conversation.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}
