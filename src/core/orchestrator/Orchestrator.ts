import { randomUUID } from "node:crypto";
import type { Brain } from "@/types/brain";
import type { ConversationManager } from "@/core/conversation/ConversationManager";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type { PermissionService } from "@/permissions/PermissionService";
import type { EventBus } from "@/core/events/EventBus";
import type { ToolCallRequest, UserMessage, UserMessageImage } from "@/types/conversation";
import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { ConfirmationService } from "@/core/confirmation/ConfirmationService";
import type { DeviceTool, LocalTool, Tool, ToolResult } from "@/types/tools";
import { PermissionLevel, type PermissionCheckResult } from "@/types/permissions";
import { JARVIS_SYSTEM_PROMPT } from "@/core/brain/systemPrompt";
import type { LockdownService } from "@/core/lockdown/LockdownService";
import type { JarvisLiveStateTracker } from "@/core/state/JarvisLiveState";
import type { ToolResultCache } from "@/core/cache/ToolResultCache";
import { quarantineToolResult } from "@/core/orchestrator/toolResultQuarantine";
import { summarizeToolResult } from "./toolResultSummary";
import { classifyFastPath } from "@/core/intent/FastPathClassifier";
import { isLikelyStatusQuery, formatLiveStatus } from "@/core/state/liveStatusFormatter";
import { isLikelyWhyQuery, explainAction, findLastToolCall, noActionToExplain } from "@/core/state/actionExplainer";
import type { LiveStateSnapshot } from "@/core/state/JarvisLiveState";
import { scopeToolsForMessage } from "@/core/intent/ToolScoping";

export interface OrchestratorDependencies {
  brain: Brain;
  conversation: ConversationManager;
  toolRegistry: ToolRegistry;
  permissionService: PermissionService;
  eventBus: EventBus;
  /** Required only if any registered tool has `target: "device"`. */
  deviceRegistry?: DeviceRegistry;
  deviceConnectionManager?: DeviceConnectionManager;
  /** Required only if any registered tool requires CONFIRM/DANGEROUS. */
  confirmationService?: ConfirmationService;
  /**
   * Extra text appended to the system prompt for this Orchestrator's
   * conversations only — e.g. telling Claude it's on a phone call so it
   * knows to keep replies short and speakable. Leave unset for the default
   * (text-only) channel.
   */
  channelContext?: string;
  /**
   * Called fresh on every turn to get extra system-prompt context that can
   * change between messages — e.g. due/overdue reminders. Returning
   * undefined/empty adds nothing. Kept as a plain callback rather than a
   * concrete dependency (a ReminderStore, say) so the Orchestrator stays
   * decoupled from any specific source of "things worth mentioning right
   * now" — this is what makes JARVIS proactively say "you have a reminder
   * due" without the user having to ask, instead of only ever answering
   * exactly what was asked.
   */
  contextProvider?: () => string | undefined | Promise<string | undefined>;
  /**
   * Optional break-glass kill switch. When active, every tool above READ
   * is refused before it reaches a permission check or confirmation
   * prompt — a single flag that stops JARVIS from taking any action at
   * all (writing, sending, calling, touching a device) while it keeps
   * answering questions normally. Omitted means the feature doesn't
   * exist for this Orchestrator (never locked down).
   */
  lockdownService?: LockdownService;
  /**
   * Optional: drives the user-facing JarvisLiveState machine
   * (src/core/state/JarvisLiveState.ts) through LISTENING -> THINKING ->
   * EXECUTING -> SPEAKING -> IDLE as this Orchestrator processes a turn.
   * Omitted means live-state tracking simply doesn't happen for this
   * Orchestrator instance — every call site below already guards on it
   * being present, so this is purely additive and never required.
   */
  liveState?: JarvisLiveStateTracker;
  /**
   * Distinguishes this Orchestrator's live-state sessions from another
   * channel's for the same userId (terminal, web chat, Telegram, a phone
   * call each get their own Orchestrator instance) — the live-state
   * session key is `${liveStateChannel}:${userId}`. Defaults to "chat".
   */
  liveStateChannel?: string;
  /**
   * Optional TTL-based cache for READ-level local tool results (see
   * `ToolResultCache`'s own doc comment) — e.g. a repeated GET_WEATHER
   * for the same location within the cache's TTL is served from memory
   * instead of re-running the tool. Only ever consulted for
   * `LocalTool`s whose `requiredPermission` is `PermissionLevel.READ`:
   * anything that mutates state or has a side effect is never cached,
   * cache or no cache. Omitted means no caching happens at all — every
   * call always re-runs the tool, today's behavior.
   */
  toolResultCache?: ToolResultCache;
  /**
   * Tool Risk Model: hard cap on the total number of tool calls this
   * Orchestrator will actually execute within a single `handleUserMessage`
   * turn. Without this, a single malicious or malfunctioning brain
   * response could in principle request an unbounded number of tool calls
   * in one iteration — `MAX_TOOL_ITERATIONS` only bounds how many times we
   * go back to the brain, not how many tool calls one of those round-trips
   * can contain. Once exceeded, further tool calls in that turn are
   * refused (a `ToolResult` error, never even reaching permission checks)
   * rather than executed — the turn itself still completes normally.
   * Configurable via `JARVIS_MAX_TOOL_CALLS_PER_RUN` in `src/index.ts`;
   * defaults to `DEFAULT_MAX_TOOL_CALLS_PER_RUN` when unset, so every
   * existing Orchestrator construction site keeps working unchanged.
   */
  maxToolCallsPerRun?: number;
  /**
   * Tool Risk Model: default timeout (ms) for a LOCAL tool's `execute()`
   * call — see `Tool.timeoutMs` for the per-tool override. `0` disables
   * timeout enforcement entirely (the previous, unbounded behavior).
   * Device tools are unaffected: they already have their own network-level
   * timeout in `DeviceConnectionManager`. Defaults to
   * `DEFAULT_LOCAL_TOOL_TIMEOUT_MS` when unset.
   */
  localToolTimeoutMs?: number;
  /**
   * Optional hook letting `requestStop` also cancel any in-flight
   * Autonomous Agent Core task(s) for the same user — see the doc comment
   * on `requestStop` below. A plain duck-typed interface rather than an
   * import of `AgentCore` itself: `AgentCore` already depends on
   * `Orchestrator` (to run its plan steps through `executeToolCall`), so
   * importing it back here would create a circular module dependency for
   * no real benefit. `src/index.ts` wires the real `AgentCore` in via a
   * small adapter. Omitted means `requestStop` only ever affects this
   * Orchestrator's own plain-chat turn loop, exactly as before this hook
   * existed.
   */
  agentTaskCanceller?: { cancelActiveTasksForUser(userId: string): string[] };
}

const MAX_TOOL_ITERATIONS = 5;
/** See `OrchestratorDependencies.maxToolCallsPerRun`. Generous for any real turn — a normal turn makes a handful of tool calls at most. */
const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 30;
/** See `OrchestratorDependencies.localToolTimeoutMs`. Generous for any real network call (Gmail/Calendar/weather/etc.) while still bounding an otherwise-infinite hang. */
const DEFAULT_LOCAL_TOOL_TIMEOUT_MS = 30_000;

class LocalToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "LocalToolTimeoutError";
  }
}

/** Races `promise` against a timer; `timeoutMs <= 0` disables the race entirely (the promise is returned as-is). */
function withLocalToolTimeout<T>(promise: Promise<T>, toolName: string, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocalToolTimeoutError(toolName, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
/**
 * Generous for any real message (a long paste, a rambling phone
 * transcript) but bounded — without this, a single oversized message
 * (accidental paste, or a caller deliberately trying to run up cost/abuse
 * the phone gateway) would go straight into the model with no limit at
 * all. Rejected before touching the conversation or the brain at all, so
 * it costs nothing and never pollutes conversation history.
 */
const MAX_USER_MESSAGE_LENGTH = 8_000;

/**
 * Anthropic's own documented per-image guidance is ~5MB raw; base64
 * inflates that by ~4/3, and this is checked against the base64 string
 * length itself (cheaper than decoding first) — generous enough for any
 * real photo (an Instagram screenshot, a document photo) while still
 * bounding cost/abuse the same way MAX_USER_MESSAGE_LENGTH bounds text.
 */
const MAX_IMAGE_BASE64_LENGTH = 7_000_000;
/** More than a handful of images in one turn is almost certainly a mistake or abuse, not a real use case. */
const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Parallel Tool Execution: the maximum number of independent READ-level
 * tool calls run concurrently (via `Promise.allSettled`) within a single
 * batch. Only ever applies to consecutive READ calls in one brain
 * response's `toolCalls` array — see `runToolCallBatch`'s doc comment for
 * the full reasoning. Bounded so a single response can't fire an unbounded
 * number of concurrent network/DB calls at once.
 */
const MAX_PARALLEL_TOOL_CALLS = 5;

/**
 * The central JARVIS loop: user message -> Claude -> tool decision ->
 * permission check -> tool execution -> result back to Claude -> final
 * response. Claude only ever *requests* tools; this class is the sole
 * place that decides whether a tool actually runs, whether it runs
 * locally in Core or is dispatched to a device agent, and whether it
 * needs a fresh human confirmation before it may run at all.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  /** The JarvisLiveState session key for `userId` on this Orchestrator's channel — see `liveStateChannel` above. */
  private liveSessionId(userId: string): string {
    return `${this.deps.liveStateChannel ?? "chat"}:${userId}`;
  }

  async handleUserMessage(userId: string, content: string, images?: UserMessageImage[]): Promise<string> {
    const { brain, conversation, toolRegistry, eventBus, channelContext, contextProvider, liveState } = this.deps;
    const extraContext = [channelContext, await contextProvider?.()].filter(Boolean).join("\n\n");
    const systemPrompt = extraContext ? `${JARVIS_SYSTEM_PROMPT}\n\n${extraContext}` : JARVIS_SYSTEM_PROMPT;
    const sessionId = this.liveSessionId(userId);

    if (content.length > MAX_USER_MESSAGE_LENGTH) {
      return (
        `That message is too long (${content.length} characters, limit ${MAX_USER_MESSAGE_LENGTH}) — ` +
        "please send something shorter."
      );
    }
    if (images && images.length > MAX_IMAGES_PER_MESSAGE) {
      return `Too many images (${images.length}, limit ${MAX_IMAGES_PER_MESSAGE}) — please send fewer at a time.`;
    }
    const oversizedImage = images?.find((image) => image.data.length > MAX_IMAGE_BASE64_LENGTH);
    if (oversizedImage) {
      return "One of those images is too large — please send a smaller one.";
    }

    // "What are you doing?" status-query fast path: a deterministic read of
    // the CURRENT live-state snapshot, formatted with no brain call at all
    // — not even Fast Path's own one-call finalize below. Deliberately
    // checked here, before this turn touches `liveState` in any way (no
    // reset/transition yet): reading the snapshot first means this answers
    // with whatever is genuinely in flight for this session right now
    // (e.g. a concurrent AgentCore task still driving the same session),
    // not a value this turn's own LISTENING/THINKING bookkeeping would
    // otherwise have just overwritten. Never attempted for an image
    // message, same reasoning as the tool-shape Fast Path below. If
    // nothing is live (IDLE), `formatLiveStatus` itself returns an honest
    // "not doing anything" line rather than this code fabricating one.
    if ((!images || images.length === 0) && isLikelyStatusQuery(content)) {
      const snapshot: LiveStateSnapshot =
        liveState?.getSnapshot(sessionId, userId) ?? {
          sessionId,
          userId,
          state: "IDLE",
          stopRequested: false,
          updatedAt: Date.now(),
        };
      const reply = formatLiveStatus(snapshot);
      conversation.addUserMessage(content, images);
      conversation.addAssistantMessage(reply);
      eventBus.emit("fastPath.statusQuery", { userId, sessionId, state: snapshot.state });
      return reply;
    }

    // "Why did you do that?" fast path: a deterministic read of this
    // conversation's own history (never an LLM call, and never a
    // fabricated causal story) — see `actionExplainer.ts`'s own doc
    // comment. Checked here, before this turn's own message is recorded,
    // so `findLastToolCall` only ever sees tool calls from *before* this
    // question, never a tool call this very question might otherwise be
    // mistaken for triggering.
    if ((!images || images.length === 0) && isLikelyWhyQuery(content)) {
      const language: "en" | "he" = liveState?.getSnapshot(sessionId, userId)?.language ?? "en";
      const last = findLastToolCall(conversation.getMessages());
      const reply = last ? explainAction(last.toolName, last.triggeringMessage, language) : noActionToExplain(language);
      conversation.addUserMessage(content, images);
      conversation.addAssistantMessage(reply);
      eventBus.emit("fastPath.whyQuery", { userId, sessionId, toolName: last?.toolName });
      return reply;
    }

    // A fresh turn always starts by clearing any stop request left over
    // from a prior interrupted turn — otherwise a new message on the same
    // session would immediately look "stopped" again.
    liveState?.reset(sessionId, userId, "new turn starting");
    liveState?.transition(sessionId, userId, "LISTENING", { reason: "user message received" });

    // Dynamic Tool Scoping's "recent context" input — the previous user
    // turn, if any, captured before this turn's message is added below (so
    // it never includes the message itself). See `scopeToolsForMessage`'s
    // doc comment.
    const recentContext = this.lastUserMessageText(conversation);

    conversation.addUserMessage(content, images);

    // Denial-of-wallet protection: one runId per turn (this one call to
    // handleUserMessage), reused for every brain.chat() call this turn
    // makes across MAX_TOOL_ITERATIONS (including a Fast Path hit below) —
    // AIRouter's maxCostPerRunUsd ceiling (see its own doc comment)
    // accumulates cost against this exact id via CostTracker's per-run
    // accumulator.
    const runId = randomUUID();

    // Fast Path: a small set of known simple single-tool-call shapes are
    // recognized deterministically (no LLM call) and routed straight to
    // that one tool, through the exact same permission/confirmation/audit
    // pipeline as any other tool call — never attempted for an image
    // message, since "what's in this photo" is never one of the known
    // shapes. See `classifyFastPath`'s own doc comment for the
    // conservatism this relies on. The classification and tool-registry
    // lookup below are both synchronous and happen before any `await` in
    // this method (deliberately — introducing an `await` here even on a
    // miss would shift every turn's microtask timing by one tick, which
    // broke timing-sensitive live-state tests).
    if (!images || images.length === 0) {
      const fastPathMatch = classifyFastPath(content);
      const fastPathTool = fastPathMatch ? toolRegistry.listTools().find((t) => t.name === fastPathMatch.toolName) : undefined;

      if (fastPathMatch && fastPathTool) {
        eventBus.emit("fastPath.hit", { userId, toolName: fastPathTool.name, shape: fastPathMatch.shape });
        return await this.runFastPath(userId, sessionId, fastPathTool.name, fastPathMatch.input, systemPrompt, runId);
      }

      // Either nothing matched, or a recognized shape's tool isn't
      // registered on this Orchestrator (e.g. Spotify not configured) —
      // never guess, fall through to the full path unchanged.
      eventBus.emit("fastPath.miss", { userId });
    }

    // Dynamic Tool Scoping: a reasonably scoped subset of the tool
    // registry for this turn's brain calls, instead of always sending
    // every registered tool regardless of what the message is about. See
    // `scopeToolsForMessage`'s own doc comment for the conservative
    // fallback-to-full-set rules.
    const scopedTools = scopeToolsForMessage(content, toolRegistry.listTools(), recentContext);

    // Tool Risk Model per-run call counter — scoped to this one turn (this
    // call to handleUserMessage), reset every time. See
    // OrchestratorDependencies.maxToolCallsPerRun's doc comment for why
    // this exists on top of MAX_TOOL_ITERATIONS.
    let totalToolCallsThisRun = 0;
    const toolCallCountsThisRun = new Map<string, number>();

    try {
      liveState?.transition(sessionId, userId, "THINKING", { reason: "awaiting brain response" });

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (liveState?.isStopRequested(sessionId)) {
          return "Stopped.";
        }

        eventBus.emit("brain.request", { messageCount: conversation.getMessages().length });

        const response = await brain.chat({
          messages: conversation.getMessagesForBrain(),
          tools: toolRegistry.toToolDefinitions(scopedTools),
          context: systemPrompt,
          runId,
          taskType: "chat",
        });

        eventBus.emit("brain.response", {
          text: response.text,
          toolCallCount: response.toolCalls.length,
          serverToolUses: response.serverToolUses,
          usage: response.usage,
        });

        // A stop could have been requested while awaiting the brain call
        // above (the one checkpoint that can't itself be interrupted, see
        // requestStop's doc comment) — checked here, before committing to
        // either the SPEAKING or EXECUTING path, so a stop mid-flight
        // can't race a transition attempted out of STOPPED.
        if (liveState?.isStopRequested(sessionId)) {
          return "Stopped.";
        }

        if (response.toolCalls.length === 0) {
          conversation.addAssistantMessage(response.text);
          liveState?.transition(sessionId, userId, "SPEAKING", { reason: "formatting final reply" });
          liveState?.reset(sessionId, userId, "turn complete");
          return response.text;
        }

        conversation.addAssistantMessage(response.text, response.toolCalls);

        liveState?.transition(sessionId, userId, "EXECUTING", {
          reason: `running ${response.toolCalls.length} tool call(s)`,
        });

        const pendingToolCalls: ToolCallRequest[] = [];
        for (const toolCall of response.toolCalls) {
          if (liveState?.isStopRequested(sessionId)) {
            return "Stopped.";
          }

          totalToolCallsThisRun++;
          const perToolCount = (toolCallCountsThisRun.get(toolCall.toolName) ?? 0) + 1;
          toolCallCountsThisRun.set(toolCall.toolName, perToolCount);

          const limitError = this.toolCallLimitError(toolCall.toolName, totalToolCallsThisRun, perToolCount);
          if (limitError) {
            eventBus.emit("tool.callLimitExceeded", {
              toolName: toolCall.toolName,
              userId,
              totalToolCalls: totalToolCallsThisRun,
              limit: this.deps.maxToolCallsPerRun ?? DEFAULT_MAX_TOOL_CALLS_PER_RUN,
            });
            this.completeToolCall(toolCall, { success: false, error: limitError });
            continue;
          }

          pendingToolCalls.push(toolCall);
        }

        await this.runToolCallBatch(userId, sessionId, pendingToolCalls);

        if (liveState?.isStopRequested(sessionId)) {
          return "Stopped.";
        }
        liveState?.transition(sessionId, userId, "THINKING", { reason: "tool results returned; back to brain" });
      }

      throw new Error(`Exceeded maximum tool iterations (${MAX_TOOL_ITERATIONS}) without a final response`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      liveState?.transition(sessionId, userId, "ERROR", { reason: message });
      liveState?.reset(sessionId, userId, "recovered after error");
      throw error;
    }
  }

  /**
   * Response Interrupt (roadmap item 103) for a plain chat turn on this
   * Orchestrator's channel. Cooperative, not preemptive — see
   * `JarvisLiveStateTracker.requestStop`'s doc comment for exactly what
   * this can and can't interrupt (it stops the tool-call loop at its next
   * checkpoint; it can never abort a `Brain.chat()` call already in
   * flight, since `Brain` has no cancellation signal today). Also cancels
   * any in-flight Autonomous Agent Core task(s) for this user, via the
   * optional `agentTaskCanceller` hook — a plain chat turn and an agent
   * task are otherwise two entirely separate systems (a plain turn never
   * runs through AgentCore, and vice versa), so without this a Stop button
   * on the Command Center would silently do nothing for a user whose only
   * active work is an agent task, not a live chat turn. Returns `false`
   * only if neither had anything active to stop (no `liveState` configured
   * or the session was already idle, AND no agent task was cancelled).
   */
  requestStop(userId: string): boolean {
    const { liveState, agentTaskCanceller } = this.deps;
    const liveStateStopped = liveState ? liveState.requestStop(this.liveSessionId(userId), userId) !== undefined : false;
    const cancelledTaskIds = agentTaskCanceller?.cancelActiveTasksForUser(userId) ?? [];
    return liveStateStopped || cancelledTaskIds.length > 0;
  }

  /**
   * Returns an error message if executing `toolName` right now would
   * exceed the global per-run cap or (if set) that tool's own
   * `maxCallsPerRun`, or `null` if the call may proceed. See
   * OrchestratorDependencies.maxToolCallsPerRun's doc comment.
   */
  private toolCallLimitError(toolName: string, totalToolCalls: number, perToolCount: number): string | null {
    const globalMax = this.deps.maxToolCallsPerRun ?? DEFAULT_MAX_TOOL_CALLS_PER_RUN;
    if (totalToolCalls > globalMax) {
      return `Exceeded the maximum of ${globalMax} tool calls for this turn — refusing further tool calls to prevent a runaway loop.`;
    }

    const tool = this.deps.toolRegistry.listTools().find((t) => t.name === toolName);
    if (tool?.maxCallsPerRun !== undefined && perToolCount > tool.maxCallsPerRun) {
      return `Exceeded the maximum of ${tool.maxCallsPerRun} call(s) to "${toolName}" allowed in a single turn.`;
    }

    return null;
  }

  /** The previous user turn's raw text, if any — see its one call site's comment. */
  private lastUserMessageText(conversation: ConversationManager): string | undefined {
    const messages = conversation.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "user") return (message as UserMessage).content;
    }
    return undefined;
  }

  /**
   * Fast Path: runs `toolName` (already matched by `classifyFastPath` and
   * confirmed to be registered by the caller) through the exact same
   * `executeToolCall` pipeline every other tool call goes through — so
   * "fast" never means "unchecked": permission checks, confirmation,
   * lockdown, and audit events all still apply — then asks the brain for a
   * short final reply (with no tools exposed, since the one relevant
   * result is already known) instead of a full tool-selection round-trip
   * against the whole registry. Always returns the turn's final reply text
   * (including "Stopped." if a stop was requested mid-flight, and any
   * error message the model chose to surface for a denied/failed tool
   * call) — by the time this is called, the turn IS taking the fast path.
   */
  private async runFastPath(
    userId: string,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    systemPrompt: string,
    runId: string
  ): Promise<string> {
    const { eventBus, brain, conversation, liveState } = this.deps;

    // LISTENING can only legally transition to THINKING/IDLE (see
    // JarvisLiveState's transition table) — fast path still passes through
    // THINKING here (no brain call happens for it, classification already
    // ran synchronously above) purely to keep this a legal state sequence,
    // consistent with the normal path's LISTENING -> THINKING -> EXECUTING.
    liveState?.transition(sessionId, userId, "THINKING", { reason: "fast path: shape recognized" });

    if (liveState?.isStopRequested(sessionId)) {
      return "Stopped.";
    }

    const toolCall: ToolCallRequest = { id: randomUUID(), toolName, input };

    liveState?.transition(sessionId, userId, "EXECUTING", { reason: `fast path: running ${toolName}` });
    conversation.addAssistantMessage("", [toolCall]);
    const result = await this.executeToolCall(userId, toolCall);
    this.completeToolCall(toolCall, result);

    if (liveState?.isStopRequested(sessionId)) {
      return "Stopped.";
    }

    liveState?.transition(sessionId, userId, "THINKING", { reason: "fast path: formatting final reply" });

    eventBus.emit("brain.request", { messageCount: conversation.getMessages().length });
    const response = await brain.chat({
      messages: conversation.getMessagesForBrain(),
      // No tools exposed: the one relevant result is already known, so
      // this call's only job is to phrase a reply, not select a tool —
      // the whole point of Fast Path is skipping that selection round-trip.
      tools: [],
      context: systemPrompt,
      runId,
      taskType: "chat",
    });
    eventBus.emit("brain.response", {
      text: response.text,
      toolCallCount: response.toolCalls.length,
      serverToolUses: response.serverToolUses,
      usage: response.usage,
    });

    conversation.addAssistantMessage(response.text);
    liveState?.transition(sessionId, userId, "SPEAKING", { reason: "formatting final reply" });
    liveState?.reset(sessionId, userId, "turn complete (fast path)");
    return response.text;
  }

  private async runToolCall(userId: string, toolCall: ToolCallRequest): Promise<void> {
    const result = await this.executeToolCall(userId, toolCall);
    this.completeToolCall(toolCall, result);
  }

  /**
   * Parallel Tool Execution: runs `toolCalls` (already past the per-run
   * limit check) in order, but groups consecutive READ-permission calls
   * into batches of up to `MAX_PARALLEL_TOOL_CALLS` and runs each such
   * batch concurrently via `Promise.allSettled` — a failure in one call
   * never aborts or corrupts its siblings' results, since `allSettled`
   * always waits for every promise in the batch before this method reacts
   * to any of them. Any non-READ call (SAFE_ACTION/CONFIRM/DANGEROUS) is
   * always run alone, never batched alongside another call, however many
   * calls in a row share that permission level — this is a hard rule, not
   * a heuristic: a tool above READ can have a real side effect, and two
   * such calls could interact in ways this Orchestrator has no way to
   * reason about. Each call, whether run solo or as part of a batch, still
   * goes through the exact same `executeToolCall` -> permission check ->
   * confirmation -> execution -> audit pipeline as any other tool call —
   * parallelism here is purely about wall-clock scheduling, never a
   * shortcut around that pipeline.
   *
   * If any call in a parallel batch throws (a genuine bug in a tool's
   * `execute()`, not an `{ success: false }` result — see
   * `runLocalTool`'s own handling of the latter), every other call in that
   * batch still completes and has its result recorded via
   * `completeToolCall` before the first such error is re-thrown — matching
   * the existing sequential behavior where an uncaught tool error ends the
   * turn, while never leaving a sibling call's result silently dropped.
   */
  private async runToolCallBatch(userId: string, sessionId: string, toolCalls: ToolCallRequest[]): Promise<void> {
    const { toolRegistry, liveState } = this.deps;
    let index = 0;

    while (index < toolCalls.length) {
      if (liveState?.isStopRequested(sessionId)) {
        return;
      }

      const toolCall = toolCalls[index]!;
      const tool = toolRegistry.listTools().find((t) => t.name === toolCall.toolName);
      const isReadOnly = tool?.requiredPermission === PermissionLevel.READ;

      if (!isReadOnly) {
        await this.runToolCall(userId, toolCall);
        index++;
        continue;
      }

      const batch: ToolCallRequest[] = [];
      while (index < toolCalls.length && batch.length < MAX_PARALLEL_TOOL_CALLS) {
        const next = toolCalls[index]!;
        const nextTool = toolRegistry.listTools().find((t) => t.name === next.toolName);
        if (nextTool?.requiredPermission !== PermissionLevel.READ) break;
        batch.push(next);
        index++;
      }

      const settled = await Promise.allSettled(batch.map((tc) => this.runToolCall(userId, tc)));
      const firstRejection = settled.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      if (firstRejection) {
        throw firstRejection.reason;
      }
    }
  }

  /**
   * Runs a single tool call through exactly the same permission-check /
   * confirmation / local-or-device-dispatch pipeline as a normal chat turn,
   * and returns its `ToolResult` directly instead of writing it into any
   * `ConversationManager`. This is the seam the Autonomous Agent Core
   * (`src/agent/AgentCore.ts`) executes its plan steps through — it must
   * never reimplement tool execution, and this is what lets it reuse this
   * exact pipeline (PermissionService, ConfirmationService, lockdown,
   * device dispatch) without a Brain or conversation in the loop at all.
   * `handleUserMessage`'s own per-turn tool loop is just a thin wrapper
   * around this that also feeds the result back into conversation history.
   */
  async executeToolCall(userId: string, toolCall: ToolCallRequest): Promise<ToolResult> {
    const { toolRegistry, eventBus, lockdownService } = this.deps;

    eventBus.emit("tool.requested", { toolCall });

    const tool: Tool | undefined = toolRegistry.listTools().find((t) => t.name === toolCall.toolName);

    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolCall.toolName}` };
    }

    if (lockdownService?.isActive() && tool.requiredPermission !== PermissionLevel.READ) {
      return {
        success: false,
        error: "JARVIS is in emergency lockdown right now — only read-only actions are available.",
      };
    }

    if (tool.target === "local") {
      return this.runLocalTool(userId, tool, toolCall);
    }

    return this.runDeviceTool(userId, tool, toolCall);
  }

  /**
   * Returns null if execution may proceed. Handles both the permission
   * deny path and, for allowed-but-confirmation-required tools, actually
   * obtaining that confirmation before returning null — otherwise returns
   * the ToolResult the caller should short-circuit with.
   */
  private async authorize(
    userId: string,
    tool: Tool,
    toolCall: ToolCallRequest,
    deviceId: string | undefined,
    permissionResult: PermissionCheckResult
  ): Promise<ToolResult | null> {
    const { confirmationService } = this.deps;

    if (!permissionResult.allowed) {
      return { success: false, error: `Permission denied: ${permissionResult.reason}` };
    }

    if (!permissionResult.requiresConfirmation) {
      return null;
    }

    if (!confirmationService) {
      return {
        success: false,
        error: "This action requires confirmation, but no confirmation channel is configured",
      };
    }

    const { liveState } = this.deps;
    const sessionId = this.liveSessionId(userId);
    liveState?.transition(sessionId, userId, "WAITING", { reason: `awaiting confirmation for ${tool.name}` });

    const approved = await confirmationService.requestConfirmation({
      toolId: tool.id,
      toolName: tool.name,
      userId,
      deviceId,
      input: toolCall.input,
    });

    // Back to EXECUTING regardless of the answer — the caller (authorize's
    // own caller, runLocalTool/runDeviceTool) is still mid tool-call either
    // way; a decline just means this particular call's ToolResult will be
    // an error, not that the whole turn is done.
    liveState?.transition(sessionId, userId, "EXECUTING", { reason: "confirmation answered" });

    if (!approved) {
      return { success: false, error: "User declined to confirm this action" };
    }

    return null;
  }

  private async runLocalTool(userId: string, tool: LocalTool, toolCall: ToolCallRequest): Promise<ToolResult> {
    const { permissionService, eventBus, toolResultCache } = this.deps;

    const permissionResult = permissionService.check({
      subject: { userId },
      toolId: tool.id,
      requiredLevel: tool.requiredPermission,
    });

    eventBus.emit("permission.checked", { toolId: tool.id, result: permissionResult });

    const denied = await this.authorize(userId, tool, toolCall, undefined, permissionResult);
    if (denied) return denied;

    // Only READ-level tools are ever cache candidates — anything above
    // READ mutates state or has a real-world side effect (sending an
    // email, placing a call), and must always actually run. See
    // `ToolResultCache`'s own doc comment.
    const cacheable = tool.requiredPermission === PermissionLevel.READ;
    if (cacheable && toolResultCache) {
      const cached = toolResultCache.get(tool.name, toolCall.input);
      if (cached) {
        eventBus.emit("tool.cacheHit", { toolName: tool.name, input: toolCall.input });
        return cached;
      }
    }

    const requestId = randomUUID();
    const timeoutMs = tool.timeoutMs ?? this.deps.localToolTimeoutMs ?? DEFAULT_LOCAL_TOOL_TIMEOUT_MS;
    let result: ToolResult;
    try {
      result = await withLocalToolTimeout(tool.execute(toolCall.input, { userId, requestId }), tool.name, timeoutMs);
    } catch (error) {
      if (error instanceof LocalToolTimeoutError) {
        eventBus.emit("tool.timedOut", { toolName: tool.name, userId, timeoutMs });
        result = { success: false, error: error.message };
      } else {
        throw error;
      }
    }

    if (cacheable && toolResultCache) {
      toolResultCache.set(tool.name, toolCall.input, result);
    }

    eventBus.emit("tool.executed", {
      toolName: tool.name,
      requestId,
      result,
      userId,
      input: toolCall.input,
      resultSummary: summarizeToolResult(result),
    });
    return result;
  }

  private async runDeviceTool(userId: string, tool: DeviceTool, toolCall: ToolCallRequest): Promise<ToolResult> {
    const { permissionService, eventBus, deviceRegistry, deviceConnectionManager } = this.deps;

    if (!deviceRegistry || !deviceConnectionManager) {
      return {
        success: false,
        error: "Device execution is not configured on this Orchestrator",
      };
    }

    const requestedDeviceId =
      typeof toolCall.input.deviceId === "string" ? (toolCall.input.deviceId as string) : undefined;

    const targetDevice = requestedDeviceId
      ? deviceRegistry.getDevice(requestedDeviceId)
      : deviceRegistry.getPrimaryDevice();

    if (!targetDevice) {
      const reason = requestedDeviceId ? `Unknown device: ${requestedDeviceId}` : "No primary device registered";
      return { success: false, error: reason };
    }

    const permissionResult = permissionService.check({
      subject: { userId },
      toolId: tool.id,
      requiredLevel: tool.requiredPermission,
      deviceId: targetDevice.id,
    });

    eventBus.emit("permission.checked", { toolId: tool.id, result: permissionResult });

    const denied = await this.authorize(userId, tool, toolCall, targetDevice.id, permissionResult);
    if (denied) return denied;

    if (tool.validateInput) {
      const validation = tool.validateInput(toolCall.input);
      if (!validation.valid) {
        return { success: false, error: `Invalid input: ${validation.reason}` };
      }
    }

    try {
      const result = await deviceConnectionManager.sendToolRequest(targetDevice.id, tool.name, toolCall.input);
      eventBus.emit("tool.executed", {
        toolName: tool.name,
        requestId: toolCall.id,
        result,
        userId,
        input: toolCall.input,
        resultSummary: summarizeToolResult(result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote tool execution failed";
      return { success: false, error: message };
    }
  }

  /**
   * Feeds a tool's result back into conversation history as the message
   * the Brain will see. External Content Quarantine: the raw JSON is
   * wrapped in a structural, unambiguous delimiter marking it as
   * untrusted data before it ever reaches the model — see
   * `quarantineToolResult`'s own doc comment for the full reasoning.
   */
  private completeToolCall(toolCall: ToolCallRequest, result: ToolResult): void {
    const quarantined = quarantineToolResult(toolCall.toolName, JSON.stringify(result));
    this.deps.conversation.addToolResult(toolCall.id, toolCall.toolName, quarantined);
  }
}
