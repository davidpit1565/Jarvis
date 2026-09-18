import { describe, test, expect, afterEach } from "bun:test";
import { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import { createShareFileToPhoneTool } from "@/tools/telegram/ShareFileToPhoneTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeGateway() {
  return new TelegramGateway("bot-token", () => ({
    orchestrator: { handleUserMessage: async () => "unused" } as never,
    userId: "local-user",
  }));
}

describe("SHARE_FILE_TO_PHONE tool", () => {
  test("is SAFE_ACTION", () => {
    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
  });

  test("rejects an empty base64Content", async () => {
    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    const result = await tool.execute({ base64Content: "", filename: "notes.txt" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an empty filename", async () => {
    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    const result = await tool.execute({ base64Content: "aGVsbG8=", filename: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects base64Content over the size cap", async () => {
    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    const result = await tool.execute({ base64Content: "a".repeat(300_000), filename: "big.txt" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  test("uploads the document to the configured owner chat id", async () => {
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedForm = init?.body as FormData;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    const result = await tool.execute({ base64Content: Buffer.from("hello world").toString("base64"), filename: "notes.txt" }, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ filename: "notes.txt", sent: true });
    expect(capturedUrl).toContain("/sendDocument");
    expect(capturedForm?.get("chat_id")).toBe("12345");
    const uploaded = capturedForm?.get("document") as unknown as Blob;
    expect(await uploaded.text()).toBe("hello world");
  });

  test("returns a failure result (not a throw) when the upload fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createShareFileToPhoneTool(makeGateway(), "12345");
    const result = await tool.execute({ base64Content: "aGVsbG8=", filename: "notes.txt" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
