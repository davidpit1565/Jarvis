import { describe, test, expect, afterEach } from "bun:test";
import { AgentMailClient } from "@/agentmail/AgentMailClient";
import { AgentMailSendGuard } from "@/agentmail/AgentMailSendGuard";
import { createSendAgentEmailTool } from "@/tools/agentmail/SendAgentEmailTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;
const fixedDateKey = () => "2026-01-01";

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  return new AgentMailClient("test-api-key", "jarvis-inbox");
}

describe("SEND_AGENT_EMAIL tool", () => {
  test("is CONFIRM — same real-world-side-effect reasoning as SEND_EMAIL", () => {
    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("rejects an invalid recipient", async () => {
    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    const result = await tool.execute({ to: "not-an-email", subject: "Hi", body: "Hello" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty subject", async () => {
    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    const result = await tool.execute({ to: "bob@example.com", subject: "", body: "Hello" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty body", async () => {
    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "" }, context);
    expect(result.success).toBe(false);
  });

  test("sends via AgentMailClient and returns the new message id", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ message_id: "sent-1", thread_id: "thread-1" }), { status: 200 })) as unknown as typeof fetch;

    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello there" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ messageId: "sent-1", threadId: "thread-1", to: "bob@example.com", subject: "Hi" });
  });

  test("returns a failure result (not a throw) on an AgentMail API error", async () => {
    global.fetch = (async () => new Response("insufficient scope", { status: 403 })) as unknown as typeof fetch;

    const tool = createSendAgentEmailTool(makeClient(), new AgentMailSendGuard(20), fixedDateKey);
    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });

  test("enforces the daily send cap, blocking further sends once reached", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ message_id: "m1", thread_id: "t1" }), { status: 200 })) as unknown as typeof fetch;

    const guard = new AgentMailSendGuard(1);
    const tool = createSendAgentEmailTool(makeClient(), guard, fixedDateKey);

    const first = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello" }, context);
    expect(first.success).toBe(true);

    const second = await tool.execute({ to: "bob@example.com", subject: "Hi again", body: "Hello again" }, context);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/daily send limit/i);
  });

  test("never consumes the daily cap on a validation failure", async () => {
    const guard = new AgentMailSendGuard(1);
    const tool = createSendAgentEmailTool(makeClient(), guard, fixedDateKey);

    await tool.execute({ to: "not-an-email", subject: "Hi", body: "Hello" }, context);

    expect(guard.remaining(fixedDateKey())).toBe(1);
  });

  test("refunds the consumed slot when the AgentMail API call itself fails, so a transient failure doesn't burn quota", async () => {
    global.fetch = (async () => new Response("insufficient scope", { status: 403 })) as unknown as typeof fetch;

    const guard = new AgentMailSendGuard(1);
    const tool = createSendAgentEmailTool(makeClient(), guard, fixedDateKey);

    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello" }, context);

    expect(result.success).toBe(false);
    expect(guard.remaining(fixedDateKey())).toBe(1);
  });

  test("refunds the same day's slot even if the day rolls over while the AgentMail call is in flight", async () => {
    global.fetch = (async () => new Response("insufficient scope", { status: 403 })) as unknown as typeof fetch;

    // Simulates local midnight ticking over during the awaited
    // sendMessage() call: the first call (tryConsume) sees "2026-01-01",
    // the second (release, in the catch block) would see "2026-01-02" if
    // the tool re-invoked todayDateKey() instead of reusing a single
    // captured value.
    let call = 0;
    const rollingDateKey = () => (call++ === 0 ? "2026-01-01" : "2026-01-02");

    const guard = new AgentMailSendGuard(1);
    const tool = createSendAgentEmailTool(makeClient(), guard, rollingDateKey);

    const result = await tool.execute({ to: "bob@example.com", subject: "Hi", body: "Hello" }, context);

    expect(result.success).toBe(false);
    expect(guard.remaining("2026-01-01")).toBe(1);
    expect(guard.remaining("2026-01-02")).toBe(1);
  });
});
