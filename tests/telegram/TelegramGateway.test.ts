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

  test("replies with a graceful not-yet-supported message for a photo, instead of staying silent", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, photo: [{ file_id: "abc" }] } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.chatId).toBe("123");
    expect(calls[0]?.text).toMatch(/just text for now/i);
  });

  test("replies with a graceful not-yet-supported message for a voice note", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, voice: { file_id: "abc" } } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/voice notes/i);
  });

  test("does not reply to a photo/voice message from a disallowed chat", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway(
      "bot-token",
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      ["999"]
    );

    await gateway.handleUpdate({ message: { chat: { id: 123 }, photo: [{ file_id: "abc" }] } });

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

describe("TelegramGateway.sendMessage", () => {
  test("sends a short message as a single request", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.sendMessage("123", "short reply");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("short reply");
  });

  test("splits a message over Telegram's 4096-character limit into multiple requests", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const longText = "a".repeat(9000);
    await gateway.sendMessage("123", longText);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.text.length).toBeLessThanOrEqual(4096);
    }
    expect(calls.map((c) => c.text).join("")).toBe(longText);
  });

  test("prefers to split on a newline near the limit rather than mid-word", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const firstLine = "x".repeat(4000);
    const secondLine = "y".repeat(4000);
    const longText = `${firstLine}\n${secondLine}`;
    await gateway.sendMessage("123", longText);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toBe(firstLine);
    expect(calls[1]!.text).toBe(secondLine);
  });
});

describe("TelegramGateway send retry safety", () => {
  test("does not retry a network-level failure on sendMessage (ambiguous whether Telegram already received it)", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      throw new Error("connection reset");
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await expect(gateway.sendMessage("123", "hi")).rejects.toThrow("connection reset");
    expect(fetchCalls).toBe(1);
  });

  test("still retries a 429 on sendMessage (request never reached processing)", async () => {
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) return new Response(null, { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.sendMessage("123", "hi");
    expect(fetchCalls).toBe(2);
  });
});

describe("TelegramGateway.sendDocument", () => {
  test("uploads the decoded bytes as multipart form data", async () => {
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.sendDocument("123", Buffer.from("hello world").toString("base64"), "notes.txt");

    expect(capturedUrl).toBe("https://api.telegram.org/botbot-token/sendDocument");
    expect(capturedForm?.get("chat_id")).toBe("123");
    const uploaded = capturedForm?.get("document") as unknown as Blob;
    expect(await uploaded.text()).toBe("hello world");
  });

  test("throws on empty base64Content", async () => {
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await expect(gateway.sendDocument("123", "", "notes.txt")).rejects.toThrow("zero bytes");
  });

  test("propagates a non-ok response as a thrown error", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await expect(gateway.sendDocument("123", "aGVsbG8=", "notes.txt")).rejects.toThrow("500");
  });
});

describe("TelegramGateway.sendPhoto", () => {
  test("POSTs the photo URL as JSON, not multipart", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: { chat_id: string; photo: string; caption?: string } | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.sendPhoto("123", "https://image.pollinations.ai/prompt/robot", "a cute robot");

    expect(capturedUrl).toBe("https://api.telegram.org/botbot-token/sendPhoto");
    expect(capturedBody?.chat_id).toBe("123");
    expect(capturedBody?.photo).toBe("https://image.pollinations.ai/prompt/robot");
    expect(capturedBody?.caption).toBe("a cute robot");
  });

  test("omits caption when not given", async () => {
    let capturedBody: { chat_id: string; photo: string; caption?: string } | undefined;
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await gateway.sendPhoto("123", "https://image.pollinations.ai/prompt/robot");

    expect(capturedBody?.caption).toBeUndefined();
  });

  test("propagates a non-ok response as a thrown error", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    await expect(gateway.sendPhoto("123", "https://image.pollinations.ai/prompt/robot")).rejects.toThrow("500");
  });
});

describe("TelegramGateway.awaitConfirmation", () => {
  test("resolves true when the chat replies yes", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const confirmationPromise = gateway.awaitConfirmation("123", "Approve?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "yes" } });

    expect(await confirmationPromise).toBe(true);
    expect(calls.some((c) => c.text === "Approve?")).toBe(true);
    expect(calls.some((c) => c.text === "Confirmed.")).toBe(true);
  });

  test("resolves false when the chat replies no", async () => {
    stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const confirmationPromise = gateway.awaitConfirmation("123", "Approve?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "no" } });

    expect(await confirmationPromise).toBe(false);
  });

  test("accepts Hebrew yes/no replies", async () => {
    stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const confirmationPromise = gateway.awaitConfirmation("123", "Approve?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "כן" } });

    expect(await confirmationPromise).toBe(true);
  });

  test("re-prompts on an unrecognized reply instead of dispatching to the orchestrator", async () => {
    const { calls } = stubSendMessage();
    let orchestratorCalls = 0;
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => {
        orchestratorCalls++;
        return "unused";
      }),
      userId: "local-user",
    }));

    const confirmationPromise = gateway.awaitConfirmation("123", "Approve?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "maybe later" } });

    expect(orchestratorCalls).toBe(0);
    expect(calls.some((c) => c.text.match(/reply yes or no/i))).toBe(true);

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "yes" } });
    expect(await confirmationPromise).toBe(true);
  });

  test("an unanswered confirmation times out to false and clears the pending entry, instead of bricking the chat", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "a real reply"),
      userId: "local-user",
    }));

    const confirmationPromise = gateway.awaitConfirmation("123", "Approve?", 10);
    expect(await confirmationPromise).toBe(false);

    // A normal message sent afterward must reach the orchestrator like any
    // other — not get treated as a stale yes/no answer.
    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "what's the weather" } });

    expect(calls.some((c) => c.text === "a real reply")).toBe(true);
    expect(calls.some((c) => c.text.match(/reply yes or no/i))).toBe(false);
  });
});

describe("TelegramGateway /start and /help commands", () => {
  test("/start replies with a canned greeting, never reaching the orchestrator", async () => {
    const { calls } = stubSendMessage();
    let orchestratorCalls = 0;
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => {
        orchestratorCalls++;
        return "unused";
      }),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "/start" } });

    expect(orchestratorCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/JARVIS/i);
  });

  test("/help replies with a canned help message, never reaching the orchestrator", async () => {
    const { calls } = stubSendMessage();
    let orchestratorCalls = 0;
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => {
        orchestratorCalls++;
        return "unused";
      }),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "/help" } });

    expect(orchestratorCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a message that merely contains /start is still dispatched to the orchestrator normally", async () => {
    const { calls } = stubSendMessage();
    const gateway = new TelegramGateway("bot-token", () => ({
      orchestrator: makeStubOrchestrator(async () => "reply"),
      userId: "local-user",
    }));

    await gateway.handleUpdate({ message: { chat: { id: 123 }, text: "can you /start the coffee machine" } });

    expect(calls).toEqual([{ chatId: "123", text: "reply" }]);
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
