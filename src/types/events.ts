import type { ToolCallRequest, ConversationMessage } from "./conversation";
import type { PermissionCheckResult } from "./permissions";
import type { Device, DeviceRole } from "./devices";
import type { ToolResult } from "./tools";
import type { TokenUsage } from "./brain";

export interface JarvisEventMap {
  "conversation.message": { message: ConversationMessage };
  "brain.request": { messageCount: number };
  "brain.response": { text: string; toolCallCount: number; serverToolUses?: string[]; usage?: TokenUsage };
  "tool.requested": { toolCall: ToolCallRequest };
  "tool.executed": {
    toolName: string;
    requestId: string;
    result: ToolResult;
    userId: string;
    input: Record<string, unknown>;
    /**
     * A short, safe, human-readable summary of `result`, derived only from
     * real data (e.g. "3 results" from an actual array length) — never a
     * fabricated or estimated count. Omitted whenever there's no cheap,
     * safe way to summarize the result (see `summarizeToolResult` in
     * `@/core/orchestrator/toolResultSummary`), so a UI rendering a live
     * timeline ("Checking calendar… ✓ 7 events found") must fall back to a
     * generic "done"/"failed" label rather than ever inventing a number.
     */
    resultSummary?: string;
    /**
     * The `ToolCallRequest.id` this execution is for — Observability
     * (Phase 43). Distinct from `requestId` above (a fresh id minted per
     * local-tool execution, passed to the tool's own `ToolContext`); this
     * is the stable id the brain/conversation/audit trail already know the
     * call by. Always set (local and device tools both know their own
     * `toolCall.id`).
     */
    toolCallId: string;
    /**
     * The AI turn/run this tool call happened within, when known — the
     * same id `Orchestrator.handleUserMessage` generates per chat turn
     * (reused across that turn's `brain.chat()` calls) or `AgentCore` uses
     * its `taskId` for. Lets a listener (e.g. `ToolAuditLog.record`)
     * correlate "this AI call" with "these tool calls" for one turn.
     * Omitted when no run scope is available.
     */
    runId?: string;
  };
  "tool.dispatched": { toolName: string; deviceId: string; requestId: string };
  /**
   * A READ-level local tool call was served from `ToolResultCache` instead
   * of actually re-running the tool. `semantic: true` means this was a
   * Semantic Result Cache hit (a differently-worded but similar-enough
   * call to a `Tool.semanticCacheable` tool) rather than an exact-match
   * hit — omitted (the default, and the only possibility before this
   * feature existed) means an ordinary exact-match hit.
   */
  "tool.cacheHit": { toolName: string; input: Record<string, unknown>; semantic?: boolean };
  /**
   * Tool Risk Model: a tool call was refused — never even reaching
   * permission checks or execution — because it would exceed the
   * per-run call cap (global default or this tool's own `maxCallsPerRun`)
   * for the current Orchestrator turn. A real signal of a runaway/looping
   * turn, worth watching for even though the turn itself recovers.
   */
  "tool.callLimitExceeded": { toolName: string; userId: string; totalToolCalls: number; limit: number };
  /** A local tool's `execute()` was aborted after exceeding its configured timeout instead of hanging forever. */
  "tool.timedOut": { toolName: string; userId: string; timeoutMs: number };
  /**
   * Fast Path: a user message deterministically matched one of a small set
   * of known simple single-tool-call shapes (see
   * `src/core/intent/FastPathClassifier.ts`) and was routed straight to
   * that tool instead of a full brain round-trip with the whole tool
   * registry exposed. `shape` names which recognized pattern matched (e.g.
   * "weather.current") — pure observability, never used for control flow.
   */
  "fastPath.hit": { userId: string; toolName: string; shape: string };
  /**
   * Fast Path: the message didn't clearly match any known fast-path shape
   * and fell through to the normal full path unchanged. Emitted so
   * fast-path coverage is measurable (hit-rate) rather than assumed —
   * every `handleUserMessage` turn emits exactly one of `fastPath.hit` or
   * `fastPath.miss`.
   */
  "fastPath.miss": { userId: string };
  /**
   * Fast Path: the message deterministically matched one of a small set of
   * known "what are you doing?" status-query phrases (English/Hebrew — see
   * `isLikelyStatusQuery` in `src/core/state/liveStatusFormatter.ts`) and
   * was answered directly from the current `JarvisLiveState` snapshot, with
   * no brain call at all — not even Fast Path's own one-call finalize.
   * `state` is the live state actually read to produce the reply, for
   * observability. A separate event from `fastPath.hit`/`fastPath.miss`
   * (which are about the tool-shape classifier) since this shortcut never
   * runs a tool and never calls the brain, so neither of those two
   * accurately describes it — a turn that takes this path emits this event
   * instead of either of those.
   */
  "fastPath.statusQuery": { userId: string; sessionId: string; state: string };
  /**
   * Fast Path: the message deterministically matched one of a small set of
   * known "why did you do that?" phrases (English/Hebrew — see
   * `isLikelyWhyQuery` in `src/core/state/actionExplainer.ts`) and was
   * answered directly from the most recent tool call in this
   * conversation's history, with no brain call at all. `toolName` is the
   * tool being explained, omitted when there was nothing to explain yet
   * (an honest "I haven't done anything to explain yet" reply).
   */
  "fastPath.whyQuery": { userId: string; sessionId: string; toolName?: string };
  "permission.checked": { toolId: string; result: PermissionCheckResult };
  "device.registered": { device: Device };
  "device.connected": { deviceId: string };
  "device.disconnected": { deviceId: string; reason: string };
  "device.roleGranted": { deviceId: string; role: DeviceRole };
  "device.revoked": { deviceId: string };
  /**
   * AIRouter switched away from its primary provider for this call:
   * "call-failed" (the primary's call threw), "budget-exceeded" (a
   * daily/monthly cost cap blocked a paid provider), "run-budget-exceeded"
   * (this run's own `maxCostPerRunUsd` ceiling — Denial-of-wallet
   * protection — blocked a paid provider), "zero-cost-mode"
   * (ZERO_COST_MODE forbade a paid provider outright), "circuit-open"
   * (the primary's circuit breaker is open after repeated failures), or
   * "soft-budget-cap" (budget-constrained degradation — spend is close to,
   * but not yet at, a configured daily/monthly cap, so a paid candidate
   * was proactively swapped for a free one; see
   * `AIRouterOptions.softBudgetCapRatio`).
   */
  "ai.providerFallback": {
    from: string;
    to: string;
    reason: "call-failed" | "budget-exceeded" | "run-budget-exceeded" | "zero-cost-mode" | "circuit-open" | "soft-budget-cap";
  };
  /**
   * Model Escalation: `AIRouter.chatWithEscalation` retried a call
   * against a stronger provider after the caller's deterministic
   * `isValid` check rejected the first response (schema validation
   * failure, empty response, tool-call parse failure). Always exactly
   * one retry per call — never emitted more than once per
   * `chatWithEscalation` invocation.
   */
  "ai.escalation": { from: string; to: string; reason: "validation-failed" };
  /** An AgentCore task moved from one state to another — see src/agent/AgentTaskStateMachine.ts for the legal transitions. */
  "agent.task.transition": {
    taskId: string;
    userId: string;
    from: string;
    to: string;
    reason: string;
    /**
     * Safe, user-facing phase name for a UI timeline, mapped from `to` via
     * `phaseForAgentTaskState` (src/agent/AgentTaskStateMachine.ts).
     * Optional only for backward compatibility with any old event shape;
     * every real emission includes it.
     */
    phase?: "RECEIVING" | "UNDERSTANDING" | "PLANNING" | "EXECUTING" | "VERIFYING" | "RECOVERING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
  };
  /**
   * JARVIS's user-facing live state (see src/core/state/JarvisLiveState.ts)
   * moved from one value to another for a given session — roadmap items
   * 92-97/101-103 and the backend half of item 36. `sessionId` is the
   * opaque per-channel key (`${channel}:${userId}` by convention);
   * `userId` is included directly too so a consumer that only cares about
   * "this user" doesn't need to parse `sessionId`. `language`, when
   * present, is the reply language ("en" | "he") known for this session at
   * the time of the transition. Forwarded to WebSocket observer clients —
   * see JarvisWebSocketServer's OBSERVABLE_EVENTS list.
   */
  "jarvis.liveState.changed": {
    sessionId: string;
    userId: string;
    from: string;
    to: string;
    reason?: string;
    language?: "en" | "he";
    timestamp: number;
  };
}

export type JarvisEventName = keyof JarvisEventMap;
