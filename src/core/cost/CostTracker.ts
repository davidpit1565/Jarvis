import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenUsage } from "@/types/brain";

/**
 * Rough, approximate $/token pricing used only to estimate a paid call's
 * cost when nothing more precise is available — NOT Anthropic's real,
 * current published pricing, and not tracking prompt-cache discounts.
 * This exists so AIRouter/CostTracker have *some* honest-effort number to
 * work with for budget enforcement, not to be a billing-accurate figure
 * (the existing `costAlertThresholdUsd`/TokenUsageStore feature has the
 * same caveat — see README).
 */
const ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD = 3;
const ANTHROPIC_OUTPUT_COST_PER_MILLION_TOKENS_USD = 15;

/**
 * Flat per-call fallback used only when a paid provider's response carries
 * no usage/token counts at all (shouldn't normally happen for Anthropic,
 * but a stub/mocked Brain in a test, or a future paid provider that
 * doesn't report usage, would hit this). Clearly an approximation, not a
 * real bill.
 */
const PAID_PROVIDER_FLAT_FALLBACK_COST_USD = 0.01;

/** Groq's free tier: genuinely $0, not an estimate. */
const FREE_PROVIDER_COST_USD = 0;

const KNOWN_FREE_PROVIDERS = new Set(["groq"]);

/**
 * Approximates a single brain call's cost in USD. Free providers (Groq)
 * are always exactly $0 — that's the point of them. A paid provider
 * (Anthropic) uses its token usage when available; otherwise falls back
 * to a flat, clearly-approximate per-call constant rather than silently
 * recording $0 for a call that really did cost something.
 */
export function estimateCostUsd(provider: string, usage?: TokenUsage): number {
  if (KNOWN_FREE_PROVIDERS.has(provider)) return FREE_PROVIDER_COST_USD;

  if (usage) {
    const inputCost = (usage.inputTokens / 1_000_000) * ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD;
    const outputCost = (usage.outputTokens / 1_000_000) * ANTHROPIC_OUTPUT_COST_PER_MILLION_TOKENS_USD;
    return inputCost + outputCost;
  }

  return PAID_PROVIDER_FLAT_FALLBACK_COST_USD;
}

export interface CostRecord {
  id: string;
  provider: string;
  estimatedCostUsd: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

/**
 * Local SQLite-backed store of every brain call's estimated cost, so
 * AIRouter can enforce MAX_DAILY_COST_USD/MAX_MONTHLY_COST_USD without
 * re-deriving spend from scratch each time. Same house style as
 * ReminderStore: a plain constructor(dbPath), a close(), no ORM.
 */
export class CostTracker {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_costs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_costs_timestamp ON ai_costs(timestamp)`);
  }

  /** Records one brain call's estimated cost. `timestamp` defaults to now (ISO 8601, UTC). */
  record(provider: string, estimatedCostUsd: number, timestamp: string = new Date().toISOString()): CostRecord {
    const record: CostRecord = { id: randomUUID(), provider, estimatedCostUsd, timestamp };
    this.db
      .query(`INSERT INTO ai_costs (id, provider, estimated_cost_usd, timestamp) VALUES (?, ?, ?, ?)`)
      .run(record.id, record.provider, record.estimatedCostUsd, record.timestamp);
    return record;
  }

  /** Sum of estimated cost for calls recorded on the same UTC calendar day as `nowIso`. */
  getTodaySpend(nowIso: string = new Date().toISOString()): number {
    const day = nowIso.slice(0, 10); // "YYYY-MM-DD"
    return this.sumSince(day);
  }

  /** Sum of estimated cost for calls recorded in the same UTC calendar month as `nowIso`. */
  getMonthSpend(nowIso: string = new Date().toISOString()): number {
    const month = nowIso.slice(0, 7); // "YYYY-MM"
    return this.sumSince(month);
  }

  private sumSince(isoPrefix: string): number {
    const row = this.db
      .query(`SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM ai_costs WHERE timestamp LIKE ?`)
      .get(`${isoPrefix}%`) as { total: number };
    return row.total;
  }

  /**
   * Per-provider spend/call-count totals, most-expensive-first — the
   * breakdown a Cost Analytics panel needs (JARVIS_ROADMAP_AUDIT.md #192)
   * that `getTodaySpend`/`getMonthSpend` alone don't give (they only sum
   * across every provider). `sinceIso` restricts to calls recorded at or
   * after that timestamp; omit for all-time.
   */
  getBreakdownByProvider(sinceIso?: string): Array<{ provider: string; totalUsd: number; calls: number }> {
    const rows = sinceIso
      ? (this.db
          .query(
            `SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs WHERE timestamp >= ? GROUP BY provider ORDER BY totalUsd DESC`
          )
          .all(sinceIso) as Array<{ provider: string; totalUsd: number; calls: number }>)
      : (this.db
          .query(
            `SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs GROUP BY provider ORDER BY totalUsd DESC`
          )
          .all() as Array<{ provider: string; totalUsd: number; calls: number }>);
    return rows;
  }

  /** The most recent `limit` recorded calls, newest first — for a Cost Analytics panel's "recent activity" list. */
  listRecent(limit = 50): CostRecord[] {
    const rows = this.db
      .query(
        `SELECT id, provider, estimated_cost_usd as estimatedCostUsd, timestamp
         FROM ai_costs ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as CostRecord[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
