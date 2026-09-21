import { describe, test, expect } from "bun:test";
import { ConversationManager } from "@/core/conversation/ConversationManager";

describe("ConversationManager", () => {
  test("preserves message order within a turn", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("hi");
    conversation.addAssistantMessage("hello");

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", toolCalls: undefined },
    ]);
  });

  test("keeps a full tool_use/tool_result pair together within a turn", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("do the thing");
    conversation.addAssistantMessage("", [{ id: "call-1", toolName: "some_tool", input: {} }]);
    conversation.addToolResult("call-1", "some_tool", '{"success":true}');
    conversation.addAssistantMessage("done");

    expect(conversation.getMessages()).toHaveLength(4);
  });

  test("clear empties the conversation", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("hi");
    conversation.clear();
    expect(conversation.getMessages()).toEqual([]);
  });

  test("trims the oldest turn once maxTurns is exceeded", () => {
    const conversation = new ConversationManager(undefined, 2);
    conversation.addUserMessage("turn 1");
    conversation.addAssistantMessage("reply 1");
    conversation.addUserMessage("turn 2");
    conversation.addAssistantMessage("reply 2");
    conversation.addUserMessage("turn 3");
    conversation.addAssistantMessage("reply 3");

    const messages = conversation.getMessages();
    expect(messages).toHaveLength(4); // only the last 2 turns survive
    expect(messages[0]).toEqual({ role: "user", content: "turn 2" });
    expect(messages[2]).toEqual({ role: "user", content: "turn 3" });
  });

  test("trimming never orphans a tool_result from its tool_use — whole turns only", () => {
    const conversation = new ConversationManager(undefined, 1);
    conversation.addUserMessage("turn 1");
    conversation.addAssistantMessage("", [{ id: "call-1", toolName: "some_tool", input: {} }]);
    conversation.addToolResult("call-1", "some_tool", '{"success":true}');

    conversation.addUserMessage("turn 2");
    conversation.addAssistantMessage("", [{ id: "call-2", toolName: "some_tool", input: {} }]);
    conversation.addToolResult("call-2", "some_tool", '{"success":true}');

    const messages = conversation.getMessages();
    // Only turn 2's messages survive — never a tool result whose tool_use was trimmed away.
    expect(messages.every((m) => m.role !== "tool" || m.toolCallId === "call-2")).toBe(true);
    expect(messages.some((m) => m.role === "user" && m.content === "turn 1")).toBe(false);
  });

  test("emits conversation.message for every message, including after trimming", () => {
    const events: string[] = [];
    const eventBus = { emit: (_name: string, payload: { message: { role: string } }) => events.push(payload.message.role) } as never;
    const conversation = new ConversationManager(eventBus, 1);

    conversation.addUserMessage("turn 1");
    conversation.addUserMessage("turn 2");

    expect(events).toEqual(["user", "user"]);
  });

  test("defaults to a generous turn limit when none is specified", () => {
    const conversation = new ConversationManager();
    for (let i = 0; i < 60; i++) {
      conversation.addUserMessage(`turn ${i}`);
    }
    // Default is 50 turns — the earliest ones should have been trimmed.
    const messages = conversation.getMessages();
    expect(messages.length).toBeLessThan(60);
    expect(messages.some((m) => m.role === "user" && m.content === "turn 59")).toBe(true);
  });

  test("attaches images to a user turn when given", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("what's this?", [{ mediaType: "image/png", data: "abc123" }]);

    expect(conversation.getMessages()).toEqual([
      { role: "user", content: "what's this?", images: [{ mediaType: "image/png", data: "abc123" }] },
    ]);
  });

  test("normalizes an empty images array to undefined, same as omitting it", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("hi", []);

    expect(conversation.getMessages()).toEqual([{ role: "user", content: "hi" }]);
  });

  test("leaves images undefined for a plain text turn", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("hi");

    const [message] = conversation.getMessages();
    expect((message as { images?: unknown }).images).toBeUndefined();
  });

  describe("getMessagesForBrain (Context Relevance + Compression)", () => {
    test("below the compression threshold, matches getMessages() exactly", () => {
      // maxTurns 20, compressionThreshold 12, verbatim 6 — 5 turns stays under threshold.
      const conversation = new ConversationManager(undefined, 20, 12, 6);
      for (let i = 0; i < 5; i++) {
        conversation.addUserMessage(`small talk ${i}`);
        conversation.addAssistantMessage(`reply ${i}`);
      }

      expect(conversation.getMessagesForBrain()).toEqual(conversation.getMessages());
    });

    test("above the threshold, keeps the last N turns verbatim and drops older small-talk turns with no tool activity", () => {
      const conversation = new ConversationManager(undefined, 50, /*threshold*/ 4, /*verbatim*/ 2);

      // Turn 1: small talk, no tool activity — should be dropped once past the verbatim window.
      conversation.addUserMessage("how's the weather");
      conversation.addAssistantMessage("sunny");

      // Turn 2: used a tool — should survive compression even though it's older.
      conversation.addUserMessage("remember my timezone is EST");
      conversation.addAssistantMessage("", [{ id: "call-1", toolName: "save_memory", input: {} }]);
      conversation.addToolResult("call-1", "save_memory", '{"success":true}');
      conversation.addAssistantMessage("got it");

      // Turn 3: small talk again, older than the verbatim window — dropped.
      conversation.addUserMessage("tell me a joke");
      conversation.addAssistantMessage("why did the chicken...");

      // Turns 4 and 5: within the verbatim window (last 2 turns) — always kept, tool or not.
      conversation.addUserMessage("what's 2+2");
      conversation.addAssistantMessage("4");
      conversation.addUserMessage("thanks");
      conversation.addAssistantMessage("you're welcome");

      const compressed = conversation.getMessagesForBrain();
      const full = conversation.getMessages();

      // Compression actually did something.
      expect(compressed.length).toBeLessThan(full.length);

      // Small-talk turns 1 and 3 are gone.
      expect(compressed.some((m) => m.role === "user" && m.content === "how's the weather")).toBe(false);
      expect(compressed.some((m) => m.role === "user" && m.content === "tell me a joke")).toBe(false);

      // The tool-using turn survived despite being older than the verbatim window.
      expect(compressed.some((m) => m.role === "user" && m.content === "remember my timezone is EST")).toBe(true);
      expect(compressed.some((m) => m.role === "tool" && m.toolCallId === "call-1")).toBe(true);

      // The last 2 turns (verbatim window) are present in full, in order, at the end.
      expect(compressed.slice(-4)).toEqual([
        { role: "user", content: "what's 2+2" },
        { role: "assistant", content: "4", toolCalls: undefined },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome", toolCalls: undefined },
      ]);
    });

    test("compression never orphans a tool_result from its tool_use — whole turns only", () => {
      const conversation = new ConversationManager(undefined, 50, 2, 1);

      conversation.addUserMessage("turn 1 chit chat");
      conversation.addAssistantMessage("ok");

      conversation.addUserMessage("turn 2 uses a tool");
      conversation.addAssistantMessage("", [{ id: "call-a", toolName: "some_tool", input: {} }]);
      conversation.addToolResult("call-a", "some_tool", '{"success":true}');

      conversation.addUserMessage("turn 3 chit chat, most recent");
      conversation.addAssistantMessage("sure");

      const compressed = conversation.getMessagesForBrain();
      expect(compressed.every((m) => m.role !== "tool" || m.toolCallId === "call-a")).toBe(true);
    });

    test("defaults to a reasonable threshold/verbatim window when none is specified", () => {
      const conversation = new ConversationManager();
      for (let i = 0; i < 30; i++) {
        conversation.addUserMessage(`small talk ${i}`);
        conversation.addAssistantMessage(`reply ${i}`);
      }

      const compressed = conversation.getMessagesForBrain();
      const full = conversation.getMessages();
      expect(compressed.length).toBeLessThan(full.length);
      // The very last turn is always present.
      expect(compressed.some((m) => m.role === "user" && m.content === "small talk 29")).toBe(true);
    });
  });
});
