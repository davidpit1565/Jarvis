import type { PermissionLevel } from "./permissions";

/** Minimal JSON-schema-like shape, only what Claude's tool-use API needs. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolExecutionContext {
  userId: string;
  requestId: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export const ToolTarget = {
  /** Executes in-process, inside JARVIS Core. */
  LOCAL: "local",
  /** Executes on a remote device agent via the WebSocket protocol. */
  DEVICE: "device",
} as const;

export type ToolTarget = (typeof ToolTarget)[keyof typeof ToolTarget];

interface BaseTool {
  id: string;
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  requiredPermission: PermissionLevel;
  /**
   * Declares whether a successful call of this tool needs a follow-up
   * verification step (e.g. a read/list call confirming the claimed effect
   * actually happened) when it's run as a step of an autonomous agent task.
   * Left undefined for the vast majority of existing tools, in which case
   * the agent core falls back to a sane default derived from
   * `requiredPermission` (see `toolRequiresVerification` in
   * `@/tools/verificationPolicy`) — anything above READ mutates state and
   * is assumed to need verification unless a tool opts out here, and READ
   * tools never need it. Only set this explicitly to override that default
   * for a specific tool (e.g. a SAFE_ACTION tool with no meaningful way to
   * verify itself, or a CONFIRM tool whose own result is already
   * authoritative proof).
   */
  requiresVerification?: boolean;
  /**
   * Tool Risk Model: caps how many times this specific tool may be called
   * within a single Orchestrator turn (see `Orchestrator`'s per-run
   * tool-call counter), on top of the global default cap every tool
   * already gets. Left undefined for the vast majority of tools, in which
   * case only the global per-run cap applies. Set this on a tool where
   * even a handful of repeated calls in one turn is inherently suspicious
   * (e.g. SEND_EMAIL, DELETE_MEMORY) — a tighter, tool-specific ceiling
   * independent of the global default.
   */
  maxCallsPerRun?: number;
  /**
   * Tool Risk Model: maximum time (ms) this local tool's `execute()` may
   * run before Orchestrator.runLocalTool aborts it with a timeout error
   * instead of waiting forever. Left undefined uses the Orchestrator's
   * configured default (see `OrchestratorDependencies.localToolTimeoutMs`)
   * — set this explicitly only to override that default for a tool known
   * to need longer (or shorter). Device tools already have their own
   * network-level timeout (`DeviceConnectionManager.toolTimeoutMs`) and
   * don't consult this field.
   */
  timeoutMs?: number;
  /**
   * Semantic Result Cache (additive, opt-in — see `ToolResultCache`'s own
   * doc comment on its semantic layer): when true AND embeddings are
   * configured (OLLAMA_EMBEDDING_MODEL set), a cache miss on this tool's
   * exact input also gets compared, by embedding similarity, against this
   * SAME tool's own recently-cached inputs — so "AI news today" and
   * "today's AI news" can hit the same cache entry despite not matching
   * character-for-character. Left undefined/false (the default, and the
   * only possibility when embeddings aren't configured at all) means this
   * tool only ever gets exact-match caching, exactly as before this
   * feature existed.
   *
   * Deliberately per-tool, not global: this only makes sense for a tool
   * whose input is a loosely-phrased natural-language query where two
   * different phrasings plausibly deserve the exact same real-world
   * answer within the cache's TTL (e.g. a news/RSS search) — never for a
   * tool where a small difference in input changes the correct answer
   * (a specific date, a specific city, a specific person). Never applies
   * above READ permission regardless of this flag — ToolResultCache/
   * Orchestrator only ever consult ANY cache (exact or semantic) for
   * READ-level local tools in the first place.
   */
  semanticCacheable?: boolean;
}

export interface LocalTool<TInput extends Record<string, unknown> = Record<string, unknown>> extends BaseTool {
  target: "local";
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * A tool with no local implementation: the Orchestrator resolves a target
 * device (explicit `deviceId` input, or the primary device) and dispatches
 * it over the DeviceConnectionManager. There is deliberately no `execute`
 * here — Core never runs a device tool's logic itself.
 */
export interface DeviceTool extends BaseTool {
  target: "device";
  /**
   * Optional extra validation beyond the JSON schema Claude already
   * respects (which only checks shape/types, e.g. "url must be a
   * string" — not "url must be http/https"), checked by the Orchestrator
   * before a request is ever sent to a device. A device tool whose input
   * has real semantic constraints (a URL's scheme, safe characters in an
   * app name) should provide this — genuine defense in depth alongside
   * the device agent's own validation, not a replacement for it: Core
   * rejecting bad input means it never even reaches the wire, but the
   * device agent (Phase 2's actual security boundary — see
   * AgentToolRegistry's own docs) must never assume Core did this.
   */
  validateInput?(input: Record<string, unknown>): { valid: boolean; reason?: string };
}

export type Tool<TInput extends Record<string, unknown> = Record<string, unknown>> = LocalTool<TInput> | DeviceTool;

/** Shape handed to Claude describing an available tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}
