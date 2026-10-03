// Model catalog and the effort rules that go with it.
//
// Every rule below was confirmed empirically — none of it is inferred. The
// effort rules were established on agy 1.1.12/1.1.13; the slug list and the
// 3.8 rules were re-verified against `agy models` on 1.2.5, which RETIRED the
// entire gemini-3.5-flash family and introduced gemini-3.8-flash. On
// 2026-10-03, still on 1.2.16, the catalog changed server-side: the
// claude-*-4-6 slugs were retired and claude-opus-5-5 / claude-sonnet-5-5
// arrived as effort bases, behaving exactly like gemini-3.8-flash:
//
//   --model gemini-3.8-flash                -> "requires --effort (available: low, medium, high)"
//   --model claude-opus-5-5                 -> "requires --effort (available: low, medium, high)"
//   --model claude-sonnet-5-5 --effort low  -> SUCCESS
//   --model gemini-3.1-pro   --effort medium-> "has no \"medium\" effort (available: low, high)"
//   --model gemini-3.8-flash-high --effort low -> "conflicts with --effort=low"
//   --model gpt-oss-120b-medium --effort high  -> "conflicts with --effort=high"
//   --model claude-sonnet-4-6               -> "is not recognized as a known model"
//   --effort low (no --model)               -> SUCCESS (applies to the IDE default)
//
// Offering a slug the CLI no longer knows is not a harmless stale entry: it
// costs a whole round trip to be told "is not recognized as a known model".
import type { ModelArgs } from "../src/types.ts";
import { warn } from "../src/logger.ts";

export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Base models that pair with --effort, mapped to the levels each accepts. */
const EFFORT_MODELS = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-opus-5-5": ["low", "medium", "high"],
  "claude-sonnet-5-5": ["low", "medium", "high"],
  "gpt-oss-120b": ["medium"],
} as const satisfies Record<string, readonly EffortLevel[]>;

type EffortModel = keyof typeof EFFORT_MODELS;

/**
 * Bases agy also runs bare, without --effort. Every other base REQUIRES it.
 * Measured on 1.2.16: `--model gpt-oss-120b` alone and with `--effort medium`
 * both succeed; low/high answer "has no \"low\" effort (available: medium)".
 */
const EFFORT_OPTIONAL = new Set<EffortModel>(["gpt-oss-120b"]);

/** Full slugs exactly as printed by `agy models` — effort already baked in. */
export const CANONICAL_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
] as const;

/** Canonical slugs plus the base names that pair with --effort. */
export const SELECTABLE_MODELS = [
  ...CANONICAL_MODELS,
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "gpt-oss-120b",
] as const;

export type SelectableModel = (typeof SELECTABLE_MODELS)[number];

/** Base model names, for error messages that offer them as the alternative. */
export const EFFORT_MODEL_NAMES = Object.keys(EFFORT_MODELS);

/**
 * CANONICAL_MODELS is written out by hand so the Zod enum keeps literal types,
 * which means it can drift from EFFORT_MODELS if only one side is edited.
 * Recomputing it here turns that silent divergence into a startup warning.
 */
export function assertCatalogConsistency(): void {
  const derived = Object.entries(EFFORT_MODELS).flatMap(([base, efforts]) =>
    (efforts as readonly EffortLevel[]).map((effort) => `${base}-${effort}`)
  );
  const canonical = new Set<string>(CANONICAL_MODELS);
  const missing = derived.filter((slug) => !canonical.has(slug));
  const extra = CANONICAL_MODELS.filter((slug) => !derived.includes(slug));

  if (missing.length > 0 || extra.length > 0) {
    warn(
      "catálogo interno inconsistente — " +
        `faltando em CANONICAL_MODELS: [${missing.join(", ")}]; ` +
        `sem origem em EFFORT_MODELS: [${extra.join(", ")}]`
    );
  }
}

/**
 * The schema enum is static so clients get autocompletion, but agy self-updates
 * (1.0.0 -> 1.1.12 -> 1.1.13 observed while building this). Compare the
 * compiled-in catalog against what the CLI reports and say so on stderr when
 * they diverge, rather than silently drifting (F-11).
 */
export function warnOnCatalogDrift(reported: readonly string[]): void {
  if (reported.length === 0) return;

  const known = new Set<string>(CANONICAL_MODELS);
  const added = reported.filter((slug) => !known.has(slug));
  const removed = CANONICAL_MODELS.filter((slug) => !reported.includes(slug));

  if (added.length > 0) {
    warn(`modelos novos no agy ainda não listados no enum: ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    warn(`modelos do enum que o agy não reporta mais: ${removed.join(", ")}`);
  }
}

function isEffortModel(model: SelectableModel): model is EffortModel {
  return Object.hasOwn(EFFORT_MODELS, model);
}

/**
 * Mirrors agy's own model/effort validation so an invalid combination fails
 * instantly and for free, instead of spawning a process to be told the same.
 */
export function buildModelArgs(
  model: SelectableModel | undefined,
  effort: EffortLevel | undefined
): ModelArgs {
  if (model === undefined) {
    // --effort alone is valid: it applies to whatever model the IDE defaults to.
    return { ok: true, args: effort ? [`--effort=${effort}`] : [] };
  }

  if (isEffortModel(model)) {
    const allowed: readonly EffortLevel[] = EFFORT_MODELS[model];
    if (effort === undefined) {
      if (EFFORT_OPTIONAL.has(model)) return { ok: true, args: [`--model=${model}`] };
      return {
        ok: false,
        error: `O modelo '${model}' exige o parâmetro effort (aceita: ${allowed.join(", ")}). Como alternativa use o slug completo, ex.: '${model}-${allowed[allowed.length - 1]}'.`,
      };
    }
    if (!allowed.includes(effort)) {
      return {
        ok: false,
        error: `O modelo '${model}' não aceita effort '${effort}' (aceita: ${allowed.join(", ")}).`,
      };
    }
    return { ok: true, args: [`--model=${model}`, `--effort=${effort}`] };
  }

  if (effort !== undefined) {
    // Every remaining full slug embeds its effort: agy answers "conflicts with --effort".
    return {
      ok: false,
      error: `O modelo '${model}' já embute o nível de esforço no próprio nome. Use um modelo base (${EFFORT_MODEL_NAMES.join(", ")}) se quiser controlar o esforço separadamente.`,
    };
  }

  return { ok: true, args: [`--model=${model}`] };
}
