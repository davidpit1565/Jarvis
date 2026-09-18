import { describe, test, expect, afterEach } from "bun:test";
import { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import { createNotifyUserTool } from "@/tools/telegram/NotifyUserTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("NOTIFY_USER tool", () => {
  test("is SAFE_ACTION", () => {
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: { handleUserMessage: async () => "unused" } as never,
      userId: "local-user",
    }));
    const tool = createNotifyUserTool(gateway, "12345");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("requires a non-empty message", async () => {
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: { handleUserMessage: async () => "unused" } as never,
      userId: "local-user",
    }));
    const tool = createNotifyUserTool(gateway, "12345");

    const result = await tool.execute({ message: "" }, context);
    expect(result.success).toBe(false);
  });

  test("sends the message to the configured owner chat id", async () => {
    let capturedChatId: string | undefined;
    let capturedText: string | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedChatId = String(body.chat_id);
      capturedText = body.text;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: { handleUserMessage: async () => "unused" } as never,
      userId: "local-user",
    }));
    const tool = createNotifyUserTool(gateway, "12345");

    const result = await tool.execute({ message: "build finished" }, context);

    expect(result.success).toBe(true);
    expect(capturedChatId).toBe("12345");
    expect(capturedText).toBe("build finished");
  });

  test("returns a failure result (not a throw) when sending fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: { handleUserMessage: async () => "unused" } as never,
      userId: "local-user",
    }));
    const tool = createNotifyUserTool(gateway, "12345");

    const result = await tool.execute({ message: "hi" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
