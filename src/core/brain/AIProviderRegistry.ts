import type { Brain } from "@/types/brain";

export type ProviderName = "anthropic" | "groq" | "openrouter" | "ollama";
export type CostTier = "free" | "paid";

export interface ProviderMeta {
  name: ProviderName;
  costTier: CostTier;
  isConfigured: boolean;
}

/**
 * Holds every `Brain` implementation JARVIS was actually able to
 * construct from the API keys present at startup, tagged with cost-tier
 * metadata AIRouter routes on. Deliberately does not construct anything
 * itself — src/index.ts registers whichever providers it already built
 * (GROQ_API_KEY present -> a GroqBrain; ANTHROPIC_API_KEY present -> a
 * ClaudeBrain), so this stays a plain lookup table, not a second place
 * that knows how to build a Brain.
 */
export class AIProviderRegistry {
  private brains = new Map<ProviderName, Brain>();
  private metas = new Map<ProviderName, ProviderMeta>();

  register(name: ProviderName, brain: Brain, costTier: CostTier): void {
    this.brains.set(name, brain);
    this.metas.set(name, { name, costTier, isConfigured: true });
  }

  get(name: ProviderName): Brain | undefined {
    return this.brains.get(name);
  }

  has(name: ProviderName): boolean {
    return this.brains.has(name);
  }

  getMeta(name: ProviderName): ProviderMeta | undefined {
    return this.metas.get(name);
  }

  /** All registered providers' metadata, in registration order. */
  list(): ProviderMeta[] {
    return [...this.metas.values()];
  }

  /** Names of every configured (registered) provider, in registration order. */
  listConfigured(): ProviderName[] {
    return [...this.brains.keys()];
  }

  /** Configured provider names matching a cost tier, in registration order. */
  findByCostTier(tier: CostTier): ProviderName[] {
    return this.list()
      .filter((meta) => meta.costTier === tier)
      .map((meta) => meta.name);
  }
}
