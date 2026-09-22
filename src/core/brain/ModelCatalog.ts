import type { ProviderName } from "./AIProviderRegistry";

/**
 * A structured, queryable list of the AI models JARVIS actually knows
 * about — one entry per model, not per provider — so cost tier and
 * capabilities live in one typed place instead of being re-guessed from
 * scattered model-id string literals (`DEFAULT_MODEL` in ClaudeBrain,
 * `DEFAULT_GROQ_MODEL` in GroqBrain, whatever a `.env` sets). This is
 * deliberately descriptive metadata only — it never constructs a Brain
 * or changes routing itself (AIRouter/AIProviderRegistry still own that,
 * see their own doc comments for why); the catalog exists so a future
 * status endpoint, a task-type-aware router (roadmap #47), or a
 * cost-optimization suggestion feature (#57) has one real source of
 * truth to read instead of re-deriving this by hand.
 *
 * Entries are added by hand, not fetched from a provider's models API at
 * runtime — every provider's model list already changes rarely enough,
 * and a hardcoded, reviewed list is safer than trusting a live endpoint
 * (which could list a materially different-priced model under a name
 * JARVIS already assumes is free/cheap).
 */
export interface ModelCapabilities {
  /** Real function/tool-calling support (not just "the API accepts a tools field"). */
  toolCalling: boolean;
  /** Accepts image input in the same call as text. */
  vision: boolean;
  /** Roughly how good this model is at following complex, multi-step instructions — a coarse ranking, not a benchmark score. */
  quality: "basic" | "good" | "excellent";
}

export interface ModelCatalogEntry {
  /** The exact model id a provider's API expects, e.g. "claude-sonnet-4-5-20250929". */
  id: string;
  /** Which registered `ProviderName` serves this model. */
  provider: ProviderName;
  /** Short human label, e.g. "Claude Sonnet 4.5". */
  label: string;
  costTier: "free" | "paid";
  capabilities: ModelCapabilities;
  /** One line on what this model is good for / any caveat worth knowing before picking it. */
  notes: string;
}

/**
 * The known model list. Not every model a provider offers — only the
 * ones JARVIS actually uses or could reasonably be pointed at via
 * JARVIS_GROQ_MODEL/JARVIS_OPENROUTER_MODEL/etc. `findModel` falls back
 * gracefully (returns undefined) for anything else rather than guessing.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    label: "Claude Sonnet 4.5",
    costTier: "paid",
    capabilities: { toolCalling: true, vision: true, quality: "excellent" },
    notes: "JARVIS's default brain — the model every other tradeoff in this catalog is measured against.",
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B (Groq)",
    costTier: "free",
    capabilities: { toolCalling: true, vision: false, quality: "good" },
    notes:
      "Groq's free tier (no credit card, 14,400 req/day at time of writing). Real tool-calling, no image input. " +
      "See GroqBrain's own doc comment for the honest quality tradeoff vs. Claude.",
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    provider: "openrouter",
    label: "Llama 3.3 70B Instruct (OpenRouter, free)",
    costTier: "free",
    capabilities: { toolCalling: true, vision: false, quality: "good" },
    notes:
      "OpenRouter's free tier (the \":free\" model-id suffix is OpenRouter's own convention for $0 models, rate-limited " +
      "but genuinely free). See OpenRouterBrain's own doc comment for why JARVIS only ever calls \":free\" models " +
      "through this provider.",
  },
  {
    id: "ollama-local",
    provider: "ollama",
    label: "Ollama (local model, user-chosen)",
    costTier: "free",
    capabilities: { toolCalling: true, vision: false, quality: "good" },
    notes:
      "A generic placeholder entry, not one specific model id — the actual model (Qwen2.5/Qwen3, gpt-oss, Llama, etc.) " +
      "is whatever the user has pulled locally via `ollama pull <model>` and set as OLLAMA_MODEL, so there's no single " +
      "real model id to catalog here the way there is for Groq/OpenRouter's fixed defaults. toolCalling assumes a " +
      "reasonably modern model (Qwen2.5/Qwen3, Llama 3.x-class, gpt-oss) with real function-calling support in " +
      "Ollama's OpenAI-compatible layer; vision is left false since it isn't verified for an arbitrary user-chosen " +
      "model — set it per-deployment if the user's specific model is known to support it. Always genuinely $0: there " +
      "is no paid tier for a model running on hardware the user already owns.",
  },
] as const;

/** Looks up a catalog entry by its exact model id, or undefined if this id isn't in the catalog. */
export function findModel(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

/** All catalog entries for a given provider, in catalog order. */
export function modelsForProvider(provider: ProviderName): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.provider === provider);
}

/** All catalog entries matching a cost tier, in catalog order. */
export function modelsByCostTier(costTier: "free" | "paid"): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => entry.costTier === costTier);
}
