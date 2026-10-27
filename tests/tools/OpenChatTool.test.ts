import { describe, test, expect } from "bun:test";
import { createOpenChatTool } from "@/tools/telegram/OpenChatTool";
import { PermissionLevel } from "@/types/permissions";

describe("OPEN_CHAT tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createOpenChatTool("jarvis_bot");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("already on Telegram: reports this already is the chat, no link needed", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "telegram" });
    expect(result.success).toBe(true);
    expect((result.data as { alreadyInChat?: boolean })?.alreadyInChat).toBe(true);
  });

  test("on SMS: returns a tappable Telegram deep link", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "sms" });
    expect(result.success).toBe(true);
    expect((result.data as { link?: string })?.link).toBe("https://t.me/jarvis_bot");
  });

  test("on the default chat channel: returns the link", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "chat" });
    expect(result.success).toBe(true);
    expect((result.data as { link?: string })?.link).toBe("https://t.me/jarvis_bot");
  });

  test("on the Mac voice channel: returns the link and hints OPEN_URL", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "device-voice" });
    expect(result.success).toBe(true);
    const data = result.data as { link?: string; note?: string };
    expect(data.link).toBe("https://t.me/jarvis_bot");
    expect(data.note).toContain("OPEN_URL");
  });

  test("defaults to the chat channel when none is given", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1" });
    expect(result.success).toBe(true);
    expect((result.data as { channel?: string })?.channel).toBe("chat");
  });

  // Must not fabricate success: a live phone call has no realistic way to
  // deliver a tappable link, so this must honestly fail rather than claim
  // it "opened" something the user can't actually use.
  test("on a live phone call: honestly reports this isn't available, does not fabricate success", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "phone" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.data).toBeUndefined();
  });

  test("on a wake-up call: also honestly reports this isn't available", async () => {
    const tool = createOpenChatTool("jarvis_bot");
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "wakeup-call" });
    expect(result.success).toBe(false);
  });

  // Must not fabricate a link when the bot username was never configured.
  test("with no bot username configured: honestly reports it can't produce a link", async () => {
    const tool = createOpenChatTool(undefined);
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "sms" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TELEGRAM_BOT_USERNAME");
    expect(result.data).toBeUndefined();
  });

  test("with no bot username configured, even on Telegram itself, still answers the already-in-chat case", async () => {
    const tool = createOpenChatTool(undefined);
    const result = await tool.execute({}, { userId: "u1", requestId: "r1", channel: "telegram" });
    expect(result.success).toBe(true);
    expect((result.data as { alreadyInChat?: boolean })?.alreadyInChat).toBe(true);
  });
});
