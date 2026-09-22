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

/** Groq's free tier, OpenRouter (OpenRouterBrain refuses to construct against any model id that isn't ":free"), and Ollama (a user-run local model — there is no paid tier at all): genuinely $0, not an estimate. */
const FREE_PROVIDER_COST_USD = 0;

const KNOWN_FREE_PROVIDERS = new Set(["groq", "openrouter", "ollama"]);

/**
 * Approximates a single brain call's cost in USD. Free providers (Groq)
 * are always exactly $0 — that's the point of them. A paid provider
 * (Anthropic) uses its token usage when available; otherwise falls back
 * to a flat, clearly-approximate per-call constant rather than silently
 * recording $0 for a call that really did cost something.
 */
/**
 * Anthropic's standard prompt-caching price multipliers on the base input
 * rate: writing to the cache costs 25% *more* than a normal input token,
 * reading from it costs 90% *less*. Ignoring these (as an earlier version
 * of this function did) silently undercounts real spend on every call that
 * has any cache activity — `cache_creation_input_tokens`/
 * `cache_read_input_tokens` are billed separately from `input_tokens`, not
 * folded into it, per Anthropic's usage reporting.
 */
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(provider: string, usage?: TokenUsage): number {
  if (KNOWN_FREE_PROVIDERS.has(provider)) return FREE_PROVIDER_COST_USD;

  if (usage) {
    const inputCost = (usage.inputTokens / 1_000_000) * ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD;
    const outputCost = (usage.outputTokens / 1_000_000) * ANTHROPIC_OUTPUT_COST_PER_MILLION_TOKENS_USD;
    const cacheWriteCost =
      (usage.cacheCreationInputTokens / 1_000_000) *
      ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD *
      ANTHROPIC_CACHE_WRITE_MULTIPLIER;
    const cacheReadCost =
      (usage.cacheReadInputTokens / 1_000_000) *
      ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD *
      ANTHROPIC_CACHE_READ_MULTIPLIER;
    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }

  return PAID_PROVIDER_FLAT_FALLBACK_COST_USD;
}

export interface CostRecord {
  id: string;
  provider: string;
  estimatedCostUsd: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The exact model that served this call, when known (see `BrainResponse.model`). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens written to the prompt cache this call (billed at a premium). 0 (not undefined) when prompt caching ran but nothing new was cached. */
  cacheCreationInputTokens?: number;
  /** Tokens read from the prompt cache this call (billed at a steep discount). 0 (not undefined) when prompt caching ran but nothing was reused. */
  cacheReadInputTokens?: number;
  /** The run (one chat turn / one agent task) this call belongs to, when scoped to one. */
  runId?: string;
  /** Wall-clock latency of this call in ms, when measured by the caller (AIRouter). */
  latencyMs?: number;
  /** How many tool calls Claude requested in this response. */
  toolCallCount?: number;
  /** True when this call was served by a fallback/escalation provider rather than the primary pick for this request. */
  fallback?: boolean;
  /** Coarse label for what kind of work this call served (e.g. "chat", "agent-plan"). See `BrainRequest.taskType`. */
  taskType?: string;
  /**
   * "Why did you use this model?" decision metadata (JARVIS_ROADMAP_AUDIT.md
   * batch 4): the real `AIRouter` code path that decided THIS call's
   * provider/model — a closed set of enum values (see
   * `AIRouter`'s `ProviderDecisionReason`), never free-text. Optional only
   * for backward compatibility with pre-batch-4 rows/callers that don't
   * pass one.
   */
  decisionReason?: string;
}

/** Optional extra dimensions `record()` persists alongside a call's estimated cost — the fields the unified AI Cost Ledger needs beyond just "provider + $ amount". Every field is optional: a caller (or a mocked Brain in a test) that doesn't have a given dimension simply omits it, and it's stored as NULL rather than guessed. */
export interface CostCallDetails {
  model?: string;
  usage?: TokenUsage;
  runId?: string;
  latencyMs?: number;
  toolCallCount?: number;
  fallback?: boolean;
  taskType?: string;
  /** See `CostRecord.decisionReason`. */
  decisionReason?: string;
}

/**
 * Local SQLite-backed store of every brain call's estimated cost, so
 * AIRouter can enforce MAX_DAILY_COST_USD/MAX_MONTHLY_COST_USD without
 * re-deriving spend from scratch each time. Same house style as
 * ReminderStore: a plain constructor(dbPath), a close(), no ORM.
 */
/**
 * Denial-of-wallet protection: hard upper bound on how many distinct
 * "run" (one `handleUserMessage` turn, one `AgentCore` task) cost
 * accumulators `CostTracker` keeps in memory at once. Runs are never
 * explicitly closed by every caller (a turn/task that errors out before
 * completing would otherwise leak its entry forever), so instead of
 * requiring callers to remember to call `resetRun`, the tracker evicts
 * the least-recently-touched run once this cap is hit — generous enough
 * that no real deployment's concurrent-run count gets anywhere near it,
 * while still bounding a long-lived process's memory.
 */
const MAX_TRACKED_RUNS = 2_000;

export class CostTracker {
  private db: Database;
  /**
   * In-memory (never persisted) per-run cost accumulator, insertion-
   * ordered so the oldest/least-recently-touched run is evicted first
   * once `MAX_TRACKED_RUNS` is hit. Deliberately not durable: a "run" is
   * gone the moment its turn/task ends, so there is nothing worth saving
   * past that — this exists only to enforce `AIRouter.maxCostPerRunUsd`
   * (Denial-of-wallet protection) while the run is still in flight, which
   * is a different concern from the persisted daily/monthly totals below.
   */
  private runSpend = new Map<string, number>();

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
    this.migrateLedgerColumns();
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ai_costs_run_id ON ai_costs(run_id)`);
  }

  /**
   * Adds the unified-AI-Cost-Ledger columns (JARVIS_ROADMAP_AUDIT.md batch
   * 3) to a pre-existing `ai_costs` table that predates them, so an
   * already-deployed database keeps working without a manual migration
   * step. `CREATE TABLE IF NOT EXISTS` above never adds columns to an
   * existing table, so this runs every time and is a no-op once the
   * columns already exist (checked via `PRAGMA table_info`, since SQLite's
   * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` isn't available on every
   * SQLite build this project might run against).
   */
  private migrateLedgerColumns(): void {
    const existing = new Set(
      (this.db.query(`PRAGMA table_info(ai_costs)`).all() as Array<{ name: string }>).map((col) => col.name)
    );
    const ledgerColumns: Array<[string, string]> = [
      ["model", "TEXT"],
      ["input_tokens", "INTEGER"],
      ["output_tokens", "INTEGER"],
      ["cache_creation_input_tokens", "INTEGER"],
      ["cache_read_input_tokens", "INTEGER"],
      ["run_id", "TEXT"],
      ["latency_ms", "REAL"],
      ["tool_call_count", "INTEGER"],
      ["fallback", "INTEGER"],
      ["task_type", "TEXT"],
      ["decision_reason", "TEXT"],
    ];
    for (const [name, type] of ledgerColumns) {
      if (!existing.has(name)) this.db.run(`ALTER TABLE ai_costs ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Records one brain call's estimated cost, plus — when the caller has
   * them — the rest of the unified AI Cost Ledger's per-call dimensions
   * (model, token counts incl. prompt-cache read/write, run, latency, tool
   * call count, fallback flag, task type). `details` is entirely optional
   * and every field within it is too: nothing here changes the meaning of
   * a bare `record(provider, cost)` call, which is still exactly what
   * AIRouter's budget enforcement relies on. `timestamp` defaults to now
   * (ISO 8601, UTC).
   */
  record(
    provider: string,
    estimatedCostUsd: number,
    timestamp: string = new Date().toISOString(),
    details?: CostCallDetails
  ): CostRecord {
    const record: CostRecord = {
      id: randomUUID(),
      provider,
      estimatedCostUsd,
      timestamp,
      model: details?.model,
      inputTokens: details?.usage?.inputTokens,
      outputTokens: details?.usage?.outputTokens,
      cacheCreationInputTokens: details?.usage?.cacheCreationInputTokens,
      cacheReadInputTokens: details?.usage?.cacheReadInputTokens,
      runId: details?.runId,
      latencyMs: details?.latencyMs,
      toolCallCount: details?.toolCallCount,
      fallback: details?.fallback,
      taskType: details?.taskType,
      decisionReason: details?.decisionReason,
    };
    this.db
      .query(
        `INSERT INTO ai_costs (
           id, provider, estimated_cost_usd, timestamp, model, input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens, run_id, latency_ms,
           tool_call_count, fallback, task_type, decision_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.provider,
        record.estimatedCostUsd,
        record.timestamp,
        record.model ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheCreationInputTokens ?? null,
        record.cacheReadInputTokens ?? null,
        record.runId ?? null,
        record.latencyMs ?? null,
        record.toolCallCount ?? null,
        record.fallback === undefined ? null : record.fallback ? 1 : 0,
        record.taskType ?? null,
        record.decisionReason ?? null
      );
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

  /**
   * Sum of estimated cost for calls recorded in the trailing 7 days up to
   * and including `nowIso` — a rolling window, not a calendar week (there's
   * no single obviously-right "week start" across locales/timezones, and a
   * rolling window is what "spend over the last week" actually means to
   * someone glancing at a dashboard).
   */
  getWeekSpend(nowIso: string = new Date().toISOString()): number {
    const cutoff = new Date(new Date(nowIso).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .query(`SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM ai_costs WHERE timestamp >= ? AND timestamp <= ?`)
      .get(cutoff, nowIso) as { total: number };
    return row.total;
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

  /**
   * Per-model spend/call-count totals, most-expensive-first — same shape
   * as `getBreakdownByProvider` but grouped by the model dimension of the
   * unified AI Cost Ledger. Calls recorded before a model was known (or by
   * a provider/mock that doesn't report one) are grouped under "unknown"
   * rather than silently dropped, so the totals still reconcile with
   * `getTodaySpend`/`getMonthSpend`.
   */
  getBreakdownByModel(sinceIso?: string): Array<{ model: string; totalUsd: number; calls: number }> {
    const rows = sinceIso
      ? (this.db
          .query(
            `SELECT COALESCE(model, 'unknown') as model, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs WHERE timestamp >= ? GROUP BY model ORDER BY totalUsd DESC`
          )
          .all(sinceIso) as Array<{ model: string; totalUsd: number; calls: number }>)
      : (this.db
          .query(
            `SELECT COALESCE(model, 'unknown') as model, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs GROUP BY model ORDER BY totalUsd DESC`
          )
          .all() as Array<{ model: string; totalUsd: number; calls: number }>);
    return rows;
  }

  /** Per-task-type spend/call-count totals, most-expensive-first (e.g. "chat" vs "agent-plan"). See `getBreakdownByModel`'s doc comment for the "unknown" bucket rationale. */
  getBreakdownByTaskType(sinceIso?: string): Array<{ taskType: string; totalUsd: number; calls: number }> {
    const rows = sinceIso
      ? (this.db
          .query(
            `SELECT COALESCE(task_type, 'unknown') as taskType, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs WHERE timestamp >= ? GROUP BY task_type ORDER BY totalUsd DESC`
          )
          .all(sinceIso) as Array<{ taskType: string; totalUsd: number; calls: number }>)
      : (this.db
          .query(
            `SELECT COALESCE(task_type, 'unknown') as taskType, COALESCE(SUM(estimated_cost_usd), 0) as totalUsd, COUNT(*) as calls
             FROM ai_costs GROUP BY task_type ORDER BY totalUsd DESC`
          )
          .all() as Array<{ taskType: string; totalUsd: number; calls: number }>);
    return rows;
  }

  /** The most recent `limit` recorded calls, newest first — for a Cost Analytics panel's "recent activity" list. */
  listRecent(limit = 50): CostRecord[] {
    const rows = this.db
      .query(
        `SELECT id, provider, estimated_cost_usd as estimatedCostUsd, timestamp, model,
                input_tokens as inputTokens, output_tokens as outputTokens,
                cache_creation_input_tokens as cacheCreationInputTokens,
                cache_read_input_tokens as cacheReadInputTokens,
                run_id as runId, latency_ms as latencyMs, tool_call_count as toolCallCount,
                fallback, task_type as taskType, decision_reason as decisionReason
         FROM ai_costs ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as RawLedgerRow[];
    return rows.map(rowToCostRecord);
  }

  /**
   * Real, measured prompt-cache effectiveness (JARVIS_ROADMAP_AUDIT.md
   * batch 3, "measure, don't assume") — computed only from `ai_costs` rows
   * that actually carry token usage (i.e. calls recorded with
   * `CostCallDetails.usage`; a bare `record(provider, cost)` call with no
   * details is excluded rather than silently counted as a cache miss).
   * `cacheHitRate` is the fraction of those calls that read at least one
   * token from the prompt cache. `estimatedSavingsUsd` is explicitly an
   * *estimate* — it prices every cache-read token at the standard
   * Anthropic 90%-off-input-price discount, the same rate `estimateCostUsd`
   * itself uses, not a real invoice line item — callers surfacing this in
   * UI must label it as estimated, never as a measured dollar figure.
   */
  getCacheStats(sinceIso?: string): {
    calls: number;
    callsWithCacheRead: number;
    cacheHitRate: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    freshInputTokens: number;
    estimatedSavingsUsd: number;
  } {
    const row = (
      sinceIso
        ? this.db
            .query(
              `SELECT COUNT(*) as calls,
                      COALESCE(SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END), 0) as callsWithCacheRead,
                      COALESCE(SUM(cache_read_input_tokens), 0) as cacheReadTokens,
                      COALESCE(SUM(cache_creation_input_tokens), 0) as cacheCreationTokens,
                      COALESCE(SUM(input_tokens), 0) as freshInputTokens
               FROM ai_costs WHERE input_tokens IS NOT NULL AND timestamp >= ?`
            )
            .get(sinceIso)
        : this.db
            .query(
              `SELECT COUNT(*) as calls,
                      COALESCE(SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END), 0) as callsWithCacheRead,
                      COALESCE(SUM(cache_read_input_tokens), 0) as cacheReadTokens,
                      COALESCE(SUM(cache_creation_input_tokens), 0) as cacheCreationTokens,
                      COALESCE(SUM(input_tokens), 0) as freshInputTokens
               FROM ai_costs WHERE input_tokens IS NOT NULL`
            )
            .get()
    ) as {
      calls: number;
      callsWithCacheRead: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      freshInputTokens: number;
    };

    const cacheHitRate = row.calls > 0 ? row.callsWithCacheRead / row.calls : 0;
    // 90% off the standard (uncached) input rate — Anthropic's documented
    // prompt-cache-read discount. See ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD above.
    const estimatedSavingsUsd = (row.cacheReadTokens * ANTHROPIC_INPUT_COST_PER_MILLION_TOKENS_USD * 0.9) / 1_000_000;

    return { ...row, cacheHitRate, estimatedSavingsUsd };
  }

  /**
   * The full unified-AI-Cost-Ledger rollup for one run (one chat turn or
   * one agent task) — every dimension the ledger spec asks for
   * (JARVIS_ROADMAP_AUDIT.md batch 3), summed/collected across every call
   * `AIRouter` made for `runId`. Returns undefined if nothing was ever
   * recorded against this `runId` (never called, or evicted from the
   * in-memory `runSpend` accumulator — that eviction never deletes the
   * durable rows this reads from, so a very old run's ledger is still
   * queryable here even after `getRunSpend` would report 0 for it).
   * `actualCostUsd` is always undefined: JARVIS has no billing API
   * integration, only the same estimated cost `record()` always stores —
   * this field exists so the shape matches the ledger spec and callers
   * don't have to guess whether "actual cost" was silently omitted or is
   * genuinely unavailable.
   */
  getRunLedger(runId: string):
    | {
        runId: string;
        providers: string[];
        models: string[];
        taskTypes: string[];
        /** Distinct decision reasons (see `CostRecord.decisionReason`) across every call in this run, in first-seen order — "why did you use this model" for the whole run at a glance. */
        decisionReasons: string[];
        calls: number;
        inputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        outputTokens: number;
        toolCalls: number;
        fallbackCount: number;
        totalLatencyMs: number;
        estimatedCostUsd: number;
        actualCostUsd: undefined;
        firstCallAt: string;
        lastCallAt: string;
      }
    | undefined {
    const rows = this.db
      .query(
        `SELECT provider, model, estimated_cost_usd as estimatedCostUsd, timestamp,
                input_tokens as inputTokens, output_tokens as outputTokens,
                cache_creation_input_tokens as cacheCreationInputTokens,
                cache_read_input_tokens as cacheReadInputTokens,
                latency_ms as latencyMs, tool_call_count as toolCallCount, fallback, task_type as taskType,
                decision_reason as decisionReason
         FROM ai_costs WHERE run_id = ? ORDER BY timestamp ASC`
      )
      .all(runId) as Array<{
      provider: string;
      model: string | null;
      estimatedCostUsd: number;
      timestamp: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
      latencyMs: number | null;
      toolCallCount: number | null;
      fallback: number | null;
      taskType: string | null;
      decisionReason: string | null;
    }>;

    if (rows.length === 0) return undefined;

    const providers = [...new Set(rows.map((r) => r.provider))];
    const models = [...new Set(rows.map((r) => r.model).filter((m): m is string => m !== null))];
    const taskTypes = [...new Set(rows.map((r) => r.taskType).filter((t): t is string => t !== null))];
    const decisionReasons = [...new Set(rows.map((r) => r.decisionReason).filter((d): d is string => d !== null))];

    return {
      runId,
      providers,
      models,
      taskTypes,
      decisionReasons,
      calls: rows.length,
      inputTokens: sumField(rows, "inputTokens"),
      cacheCreationTokens: sumField(rows, "cacheCreationInputTokens"),
      cacheReadTokens: sumField(rows, "cacheReadInputTokens"),
      outputTokens: sumField(rows, "outputTokens"),
      toolCalls: sumField(rows, "toolCallCount"),
      fallbackCount: rows.filter((r) => r.fallback === 1).length,
      totalLatencyMs: sumField(rows, "latencyMs"),
      estimatedCostUsd: rows.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
      actualCostUsd: undefined,
      firstCallAt: rows[0]!.timestamp,
      lastCallAt: rows[rows.length - 1]!.timestamp,
    };
  }

  /**
   * Denial-of-wallet protection: adds `estimatedCostUsd` to `runId`'s
   * in-memory accumulator, in addition to (never instead of) the
   * persisted global record `record()` already wrote. `AIRouter` calls
   * this right after `record()` for every call that carries a `runId`.
   */
  recordRunCost(runId: string, estimatedCostUsd: number): void {
    const current = this.runSpend.get(runId) ?? 0;
    // Delete-then-set bumps this run to "most recently touched" in the
    // Map's iteration order, so eviction below always removes the
    // actually-oldest run, not just the first one ever inserted.
    this.runSpend.delete(runId);
    this.runSpend.set(runId, current + estimatedCostUsd);

    if (this.runSpend.size > MAX_TRACKED_RUNS) {
      const oldestKey = this.runSpend.keys().next().value;
      if (oldestKey !== undefined) this.runSpend.delete(oldestKey);
    }
  }

  /** Total estimated cost recorded against `runId` so far (0 if none recorded, or it was evicted/reset). */
  getRunSpend(runId: string): number {
    return this.runSpend.get(runId) ?? 0;
  }

  /** Clears `runId`'s accumulator. Optional — callers don't need to call this for correctness (see `MAX_TRACKED_RUNS`), only to free its slot early. */
  resetRun(runId: string): void {
    this.runSpend.delete(runId);
  }

  close(): void {
    this.db.close();
  }
}

/** Raw shape of a `listRecent` row straight off the `ai_costs` table — nullable ledger columns as SQLite actually returns them, before `rowToCostRecord` turns NULLs into undefined and the 0/1 `fallback` int into a real boolean. */
interface RawLedgerRow {
  id: string;
  provider: string;
  estimatedCostUsd: number;
  timestamp: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  runId: string | null;
  latencyMs: number | null;
  toolCallCount: number | null;
  fallback: number | null;
  taskType: string | null;
  decisionReason: string | null;
}

function rowToCostRecord(row: RawLedgerRow): CostRecord {
  return {
    id: row.id,
    provider: row.provider,
    estimatedCostUsd: row.estimatedCostUsd,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    cacheCreationInputTokens: row.cacheCreationInputTokens ?? undefined,
    cacheReadInputTokens: row.cacheReadInputTokens ?? undefined,
    runId: row.runId ?? undefined,
    latencyMs: row.latencyMs ?? undefined,
    toolCallCount: row.toolCallCount ?? undefined,
    fallback: row.fallback === null ? undefined : row.fallback === 1,
    taskType: row.taskType ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
  };
}

/** Sums a nullable numeric column across rows, treating NULL as 0 — used by `getRunLedger` so one call in a run with no usage data doesn't turn the whole run's total into NaN. */
function sumField<K extends string>(rows: Array<Record<K, number | null>>, key: K): number {
  return rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
}
