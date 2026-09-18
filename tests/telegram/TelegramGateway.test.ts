import { describe, test, expect, afterEach } from "bun:test";
import { TelegramGateway, type TelegramSession } from "@/communication/telegram/TelegramGateway";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeStubOrchestrator(handle: (userId: string, message: string) => Promise<string>): Orchestrator {
  return { handleUserMessage: handle } as unknown as Orchestrator;
}

function stubSendMessage(): { calls: Array<{ chatId: string; text: string }> } {
  const calls: Array<{ chatId: string; text: string }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push({ chatId: String(body.chat_id), text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

describe("TelegramGateway.handleUpdate", () => {
  test("replies to a plain text message in an allowed chat", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "Hello back"),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "hi" } });

    expect(calls).toEqual([{ chatId: "123", text: "Hello back" }]);
  });

  test("rejects a chat not in the allowlist, without replying", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway(
      "bot-token",
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      ["999"]
    );

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "hi" } });

    expect(calls).toHaveLength(0);
  });

  test("allows a chat that is in the allowlist", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway(
      "bot-token",
      () => ({ orchestrator: makeStubOrchestrator(async () => "ok"), userId: "local-user" }),
      ["123"]
    );

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "hi" } });

    expect(calls).toEqual([{ chatId: "123", text: "ok" }]);
  });

  test("ignores an update with no message text (e.g. a photo)", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 } } });

    expect(calls).toHaveLength(0);
  });

  test("reuses the same session/conversation across multiple messages from the same chat", async () => {
    stubSendMessage();
    let sessionsCreated = 0;
    const gateway = new TelegramGateway("bot-token", () => {
      sessionsCreated++;
      return { orchestrator: makeStubOrchestrator(async () => "reply"), userId: "local-user" };
    });

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "first" } });
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "second" } });

    expect(sessionsCreated).toBe(1);
  });

  test("sends a fallback error reply if the orchestrator throws, without throwing itself", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => {
        throw new Error("brain exploded");
      }),
      userId: "local-user",
    }));

    await expect(gateway.handleUpdate({ message: { chat: { id: 123 }, text: "hi" } })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/something went wrong/i);
  });
});

describe("TelegramGateway.isChatAllowed", () => {
  test("allows any chat when no allowlist is configured", () => {
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));
    expect(gateway.isChatAllowed("anything")).toBe(true);
  });
});
