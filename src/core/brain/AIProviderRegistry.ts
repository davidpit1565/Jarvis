import type { Brain } from "@/types/brain";

export type ProviderName = "anthropic" | "groq" | "openrouter" | "ollama" | "cloudflare-workers-ai" | "gemini";
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

  /**
   * Same as `findByCostTier`, but ordered by `priority` (names earlier in
   * `priority` sort first) instead of plain registration order. A
   * configured provider that isn't named in `priority` is never dropped —
   * it's appended after every named provider, in its original relative
   * (registration) order, so an incomplete priority list can't make a
   * provider unreachable.
   *
   * This exists as a separate method, not a change to `findByCostTier`
   * itself, because `findByCostTier`'s "registration order" contract is
   * relied on as-is elsewhere (e.g. its own existing tests, and any other
   * plain-iteration caller) — ordering by an explicit priority is a real
   * business decision (see `AIRouter`'s `FREE_PROVIDER_PRIORITY`), not the
   * default a generic lookup should silently start applying.
   */
  findByCostTierPrioritized(tier: CostTier, priority: readonly ProviderName[]): ProviderName[] {
    const rank = new Map(priority.map((name, index) => [name, index]));
    // Array#sort is a stable sort in the JS engines Bun targets (ES2019+),
    // so providers with equal rank (both unranked, or — impossible today,
    // since `priority` has no duplicates — same named rank) keep their
    // relative registration order rather than being shuffled.
    return this.findByCostTier(tier).sort((a, b) => {
      const rankA = rank.has(a) ? rank.get(a)! : Number.MAX_SAFE_INTEGER;
      const rankB = rank.has(b) ? rank.get(b)! : Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
  }
}
