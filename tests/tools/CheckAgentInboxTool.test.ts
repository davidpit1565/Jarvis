import { describe, test, expect, afterEach } from "bun:test";
import { AgentMailClient } from "@/agentmail/AgentMailClient";
import { createCheckAgentInboxTool } from "@/tools/agentmail/CheckAgentInboxTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeClient() {
  return new AgentMailClient("test-api-key", "jarvis-inbox");
}

describe("CHECK_AGENT_INBOX tool", () => {
  test("is READ — a bounded, read-only inbox listing", () => {
    const tool = createCheckAgentInboxTool(makeClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("rejects a non-positive maxResults", async () => {
    const tool = createCheckAgentInboxTool(makeClient());
    const result = await tool.execute({ maxResults: 0 }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a non-integer maxResults", async () => {
    const tool = createCheckAgentInboxTool(makeClient());
    const result = await tool.execute({ maxResults: 3.5 }, context);
    expect(result.success).toBe(false);
  });

  test("lists messages via AgentMailClient", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              message_id: "m1",
              thread_id: "t1",
              from: "alice@example.com",
              to: ["jarvis@agentmail.to"],
              subject: "Hello",
              preview: "hi",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createCheckAgentInboxTool(makeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("passes an explicit maxResults through, still bounded by the client's own cap", async () => {
    const capturedLimits: Array<string | null> = [];
    global.fetch = (async (url: string) => {
      capturedLimits.push(new URL(url).searchParams.get("limit"));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createCheckAgentInboxTool(makeClient());
    await tool.execute({ maxResults: 500 }, context);

    expect(capturedLimits[0]).toBe("20");
  });

  test("returns a failure result (not a throw) on an AgentMail API error", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const tool = createCheckAgentInboxTool(makeClient());
    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
  });
});
