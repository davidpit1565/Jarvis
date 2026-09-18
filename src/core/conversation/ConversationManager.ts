import type { AssistantMessage, ConversationMessage, ToolResultMessage } from "@/types/conversation";
import type { EventBus } from "@/core/events/EventBus";

const DEFAULT_MAX_TURNS = 50;

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
    private readonly maxTurns: number = DEFAULT_MAX_TURNS
  ) {}

  addUserMessage(content: string): void {
    const message: ConversationMessage = { role: "user", content };
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

  clear(): void {
    this.turns = [];
  }
}
