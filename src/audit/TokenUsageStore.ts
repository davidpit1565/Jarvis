import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenUsage } from "@/types/brain";

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  calls: number;
}

/**
 * Durable record of every Claude API call's token usage — the basis for
 * real cost visibility. Without this, "how much is JARVIS actually
 * costing me" has no answer beyond checking the Anthropic console days
 * later. One row per call, summed on demand rather than pre-aggregated,
 * since the volume here (one row per API call, not per tool) is small
 * enough that summing is cheap.
 */
export class TokenUsageStore {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
  }

  record(usage: TokenUsage): void {
    this.db
      .query(
        `INSERT INTO token_usage (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, timestamp) VALUES (?, ?, ?, ?, ?)`
      )
      .run(usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens, new Date().toISOString());
  }

  /** All-time totals across every recorded call. */
  totals(): TokenUsageTotals {
    const row = this.db
      .query(
        `SELECT
           COALESCE(SUM(input_tokens), 0) as inputTokens,
           COALESCE(SUM(output_tokens), 0) as outputTokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) as cacheCreationInputTokens,
           COALESCE(SUM(cache_read_input_tokens), 0) as cacheReadInputTokens,
           COUNT(*) as calls
         FROM token_usage`
      )
      .get() as TokenUsageTotals;
    return row;
  }

  close(): void {
    this.db.close();
  }
}
