import { describe, test, expect } from "bun:test";
import { explainAction, findLastToolCall, isLikelyWhyQuery, noActionToExplain } from "@/core/state/actionExplainer";
import type { ConversationMessage } from "@/types/conversation";

describe("explainAction", () => {
  test("composes a one-sentence explanation from the triggering message and the tool used", () => {
    const text = explainAction("list_calendar_events", "prepare tomorrow");
    expect(text).toBe('You asked me to "prepare tomorrow", so I used list calendar events to help with that.');
  });

  test("renders Hebrew when asked", () => {
    const text = explainAction("list_calendar_events", "תכין אותי למחר", "he");
    expect(text).toContain("list calendar events");
    expect(text).toContain("תכין אותי למחר");
  });

  test("falls back to a still-honest sentence when no triggering message is known", () => {
    const text = explainAction("get_weather", "");
    expect(text).toBe("I used get weather to help with your request.");
    expect(text).not.toContain('""');
  });
});

describe("noActionToExplain", () => {
  test("is an honest 'nothing to explain yet' line, never a fabricated action", () => {
    expect(noActionToExplain()).toMatch(/haven't done anything/i);
    expect(noActionToExplain("he")).toContain("לא עשיתי");
  });
});

describe("findLastToolCall", () => {
  function userMsg(content: string): ConversationMessage {
    return { role: "user", content };
  }

  test("returns null when no tool call has ever been made", () => {
    const messages: ConversationMessage[] = [userMsg("hi"), { role: "assistant", content: "hello", toolCalls: [] }];
    expect(findLastToolCall(messages)).toBeNull();
  });

  test("finds the most recent tool call and its triggering user message", () => {
    const messages: ConversationMessage[] = [
      userMsg("what's the weather"),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", toolName: "get_weather", input: {} }] },
      { role: "tool", toolCallId: "c1", toolName: "get_weather", content: "sunny" },
      { role: "assistant", content: "It's sunny." },
      userMsg("prepare tomorrow"),
      { role: "assistant", content: "", toolCalls: [{ id: "c2", toolName: "list_calendar_events", input: {} }] },
      { role: "tool", toolCallId: "c2", toolName: "list_calendar_events", content: "[]" },
      { role: "assistant", content: "Nothing on your calendar." },
    ];

    const result = findLastToolCall(messages);
    expect(result).toEqual({ toolName: "list_calendar_events", triggeringMessage: "prepare tomorrow" });
  });

  test("uses the last tool call within a turn that made more than one", () => {
    const messages: ConversationMessage[] = [
      userMsg("do two things"),
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", toolName: "get_weather", input: {} },
          { id: "c2", toolName: "list_calendar_events", input: {} },
        ],
      },
    ];
    expect(findLastToolCall(messages)?.toolName).toBe("list_calendar_events");
  });
});

describe("isLikelyWhyQuery", () => {
  test("matches the literal English phrasing", () => {
    expect(isLikelyWhyQuery("why did you do that")).toBe(true);
    expect(isLikelyWhyQuery("Why did you do that?")).toBe(true);
    expect(isLikelyWhyQuery("why did you check my calendar")).toBe(true);
    expect(isLikelyWhyQuery("why did you use get_weather")).toBe(true);
  });

  test("matches the literal Hebrew phrasing", () => {
    expect(isLikelyWhyQuery("למה עשית את זה")).toBe(true);
    expect(isLikelyWhyQuery("למה בדקת את הלוח שנה")).toBe(true);
  });

  test("does not match unrelated messages", () => {
    expect(isLikelyWhyQuery("what's the weather today")).toBe(false);
    expect(isLikelyWhyQuery("")).toBe(false);
    expect(isLikelyWhyQuery("why is the sky blue")).toBe(false);
  });
});
