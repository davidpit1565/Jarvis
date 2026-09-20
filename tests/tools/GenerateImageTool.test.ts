import { describe, test, expect, afterEach } from "bun:test";
import { PollinationsImageClient } from "@/images/PollinationsImageClient";
import { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import { createGenerateImageTool } from "@/tools/images/GenerateImageTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeTelegramGateway() {
  return new TelegramGateway("bot-token", () => ({
    orchestrator: { handleUserMessage: async () => "unused" } as never,
    userId: "local-user",
  }));
}

describe("GENERATE_IMAGE tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createGenerateImageTool(new PollinationsImageClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("rejects an empty prompt", async () => {
    const tool = createGenerateImageTool(new PollinationsImageClient());
    const result = await tool.execute({ prompt: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an overly long prompt", async () => {
    const tool = createGenerateImageTool(new PollinationsImageClient());
    const result = await tool.execute({ prompt: "a".repeat(3000) }, context);
    expect(result.success).toBe(false);
  });

  test("returns the generated image URL even with no Telegram configured", async () => {
    const tool = createGenerateImageTool(new PollinationsImageClient());
    const result = await tool.execute({ prompt: "a cute robot" }, context);

    expect(result.success).toBe(true);
    const data = result.data as { url: string; prompt: string };
    expect(data.url).toContain("image.pollinations.ai/prompt/");
    expect(data.prompt).toBe("a cute robot");
  });

  test("also sends the image to Telegram when an owner chat is configured", async () => {
    let capturedBody: { chat_id: string; photo: string; caption?: string } | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/sendPhoto");
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createGenerateImageTool(new PollinationsImageClient(), makeTelegramGateway(), "12345");
    const result = await tool.execute({ prompt: "a cute robot" }, context);

    expect(result.success).toBe(true);
    expect(capturedBody?.chat_id).toBe("12345");
    expect(capturedBody?.photo).toContain("image.pollinations.ai/prompt/");
    expect(capturedBody?.caption).toBe("a cute robot");
  });

  test("still succeeds, with the URL, if the Telegram delivery fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createGenerateImageTool(new PollinationsImageClient(), makeTelegramGateway(), "12345");
    const result = await tool.execute({ prompt: "a cute robot" }, context);

    expect(result.success).toBe(true);
    const data = result.data as { url: string; telegramDelivery?: string };
    expect(data.url).toContain("image.pollinations.ai");
    expect(data.telegramDelivery).toContain("failed");
  });
});
