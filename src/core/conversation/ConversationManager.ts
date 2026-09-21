import type { AssistantMessage, ConversationMessage, ToolResultMessage, UserMessageImage } from "@/types/conversation";
import type { EventBus } from "@/core/events/EventBus";

const DEFAULT_MAX_TURNS = 50;

/**
 * Beyond this many turns, `getMessagesForBrain()` starts compressing
 * instead of sending everything verbatim. Below it, compression is a
 * no-op (identical to `getMessages()`) — most conversations never get
 * long enough for this to matter at all.
 */
const DEFAULT_COMPRESSION_THRESHOLD_TURNS = 12;
/** The most recent turns are always sent in full, regardless of content — recency is itself relevant. */
const DEFAULT_VERBATIM_TURNS = 6;

/**
 * Holds the in-progress conversation for a single session. This is
 * short-lived turn state, distinct from the long-term MemoryStore.
 *
 * Bounded to the last `maxTurns` user turns (a "turn" = one user message
 * plus every assistant/tool message that follows it, up to the next user
 * message) — without this, a single long-running process (the terminal
 * chat loop runs for as long as the process stays up, with no restart
 * between messages) would accumulate every message forever, resending the
 * whole history on every single API call. That's a real, unbounded cost
 * that only grows, and eventually risks exceeding the model's context
 * window outright. Trimming whole turns, never a partial one, is what
 * keeps this safe: Anthropic's API requires a tool_use block to be
 * immediately followed by its tool_result — trimming mid-turn could orphan
 * one half of that pair and break the very next API call.
 */
export class ConversationManager {
  private turns: ConversationMessage[][] = [];

  constructor(
    private readonly eventBus?: EventBus,
    private readonly maxTurns: number = DEFAULT_MAX_TURNS,
    private readonly compressionThresholdTurns: number = DEFAULT_COMPRESSION_THRESHOLD_TURNS,
    private readonly verbatimTurns: number = DEFAULT_VERBATIM_TURNS
  ) {}

  addUserMessage(content: string, images?: UserMessageImage[]): void {
    const message: ConversationMessage = { role: "user", content, images: images?.length ? images : undefined };
    this.turns.push([message]);
    this.trimToMaxTurns();
    this.eventBus?.emit("conversation.message", { message });
  }

  addAssistantMessage(content: string, toolCalls?: AssistantMessage["toolCalls"]): void {
    const message: ConversationMessage = { role: "assistant", content, toolCalls };
    this.appendToCurrentTurn(message);
    this.eventBus?.emit("conversation.message", { message });
  }

  addToolResult(toolCallId: string, toolName: string, content: string): void {
    const message: ToolResultMessage = { role: "tool", toolCallId, toolName, content };
    this.appendToCurrentTurn(message);
    this.eventBus?.emit("conversation.message", { message });
  }

  /** Appends to the most recent turn, starting one if nothing has called addUserMessage yet. */
  private appendToCurrentTurn(message: ConversationMessage): void {
    if (this.turns.length === 0) this.turns.push([]);
    this.turns[this.turns.length - 1]!.push(message);
  }

  private trimToMaxTurns(): void {
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }

  getMessages(): ConversationMessage[] {
    return this.turns.flat();
  }

  /**
   * What actually gets sent to the Brain: `getMessages()` plus a local,
   * deterministic relevance/compression pass on top of it. This never
   * calls the Brain itself (no cost, works with zero configured
   * providers) — it's a fixed heuristic, not a learned or model-driven
   * summary:
   *
   *   1. Below `compressionThresholdTurns` total turns, this is identical
   *      to `getMessages()` — nothing is dropped. Most conversations never
   *      reach the threshold.
   *   2. The most recent `verbatimTurns` turns are always kept in full,
   *      unconditionally — whatever just happened is the most likely to
   *      still be relevant.
   *   3. Among the older turns (beyond the verbatim window), only turns
   *      that did something — the assistant made a tool call, or a tool
   *      result came back (e.g. a memory was saved/searched, a reminder
   *      was created, a device action ran) — are kept. Turns that were
   *      pure small talk (a user message and a plain assistant reply,
   *      nothing else) are dropped entirely.
   *   4. Trimming only ever drops *whole* turns, same invariant as
   *      `trimToMaxTurns()` — a tool_use is never separated from its
   *      tool_result, since Anthropic's API requires them adjacent.
   *
   * This is a judgment call, not a solved problem: a long, information-
   * dense small-talk turn could in principle matter more than a trivial
   * tool call. The heuristic optimizes for the common case (tool activity
   * usually marks something worth remembering; idle chit-chat usually
   * doesn't) rather than trying to score relevance precisely.
   */
  getMessagesForBrain(): ConversationMessage[] {
    if (this.turns.length <= this.compressionThresholdTurns) {
      return this.getMessages();
    }

    const splitIndex = Math.max(0, this.turns.length - this.verbatimTurns);
    const olderTurns = this.turns.slice(0, splitIndex);
    const recentTurns = this.turns.slice(splitIndex);

    const keptOlderTurns = olderTurns.filter((turn) => turn.some((message) => this.isToolActivity(message)));

    return [...keptOlderTurns, ...recentTurns].flat();
  }

  private isToolActivity(message: ConversationMessage): boolean {
    if (message.role === "tool") return true;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) return true;
    return false;
  }

  clear(): void {
    this.turns = [];
  }
}
