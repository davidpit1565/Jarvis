import { describe, test, expect, afterEach } from "bun:test";
import { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import { CanvaClient } from "@/canva/CanvaClient";
import { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import { createExportCanvaDesignTool } from "@/tools/canva/ExportCanvaDesignTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeLinkedClient(): CanvaClient {
  const tokenStore = new CanvaTokenStore(":memory:");
  tokenStore.save({ refreshToken: "r1", accessToken: "a1", accessTokenExpiresAt: Date.now() + 3_600_000 });
  return new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore, {
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
}

function makeGateway(): { gateway: TelegramGateway; calls: Array<{ endpoint: string; body: Record<string, unknown> }> } {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const endpoint = url.split("/").pop() ?? "";
    calls.push({ endpoint, body: JSON.parse(init?.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const gateway = new TelegramGateway("bot-token", () => ({ orchestrator: {} as never, userId: "local-user" }));
  return { gateway, calls };
}

function stubExportSuccess(urls: string[]) {
  global.fetch = (async (url: string) => {
    if (url.endsWith("/exports")) {
      return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls } }), { status: 200 });
    }
    return new Response(JSON.stringify({ job: { id: "export-1", status: "success", urls } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("EXPORT_CANVA_DESIGN tool", () => {
  test("is READ", () => {
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("rejects a missing designId", async () => {
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "" }, context);
    expect(result.success).toBe(false);
  });

  test("rejects an invalid format", async () => {
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1", format: "mp4" as never }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/format must be one of/i);
  });

  test("rejects a non-array pages value", async () => {
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1", pages: "all" as never }, context);
    expect(result.success).toBe(false);
  });

  test("rejects a pages array with a non-positive-integer entry", async () => {
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1", pages: [0, 1] }, context);
    expect(result.success).toBe(false);
  });

  test("exports with the default pdf format when none is given", async () => {
    stubExportSuccess(["https://export-download.canva.com/file.pdf"]);
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { format: string }).format).toBe("pdf");
    expect((result.data as { urls: string[] }).urls).toEqual(["https://export-download.canva.com/file.pdf"]);
  });

  test("returns the export urls without attempting Telegram delivery when no gateway is configured", async () => {
    stubExportSuccess(["https://export-download.canva.com/file.pdf"]);
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { telegramDelivery?: string }).telegramDelivery).toBeUndefined();
  });

  test("delivers a pdf export to Telegram as a document, by URL", async () => {
    const stubClient = {
      exportDesign: async () => ({ id: "export-1", format: "pdf" as const, urls: ["https://export-download.canva.com/f.pdf"] }),
    } as unknown as CanvaClient;
    const { gateway, calls } = makeGateway();
    const tool = createExportCanvaDesignTool(stubClient, gateway, "chat-1");

    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { telegramDelivery: string }).telegramDelivery).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endpoint).toBe("sendDocument");
    expect(calls[0]?.body.document).toBe("https://export-download.canva.com/f.pdf");
  });

  test("delivers a png export to Telegram as an inline photo", async () => {
    const stubClient = { exportDesign: async () => ({ id: "export-1", format: "png" as const, urls: ["https://x/1.png"] }) } as unknown as CanvaClient;
    const { gateway, calls } = makeGateway();
    const tool = createExportCanvaDesignTool(stubClient, gateway, "chat-1");

    const result = await tool.execute({ designId: "D1", format: "png" }, context);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endpoint).toBe("sendPhoto");
  });

  test("still returns the export urls as a success when Telegram delivery fails", async () => {
    const stubClient = { exportDesign: async () => ({ id: "export-1", format: "pdf" as const, urls: ["https://x/1.pdf"] }) } as unknown as CanvaClient;
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const gateway = new TelegramGateway("bot-token", () => ({ orchestrator: {} as never, userId: "local-user" }));
    const tool = createExportCanvaDesignTool(stubClient, gateway, "chat-1");

    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { telegramDelivery: string }).telegramDelivery).toMatch(/^failed:/);
    expect((result.data as { urls: string[] }).urls).toEqual(["https://x/1.pdf"]);
  });

  test("surfaces a failed export job as a real failure, not fabricated success", async () => {
    global.fetch = (async (url: string) => {
      if (url.endsWith("/exports")) {
        return new Response(JSON.stringify({ job: { id: "export-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ job: { id: "export-1", status: "failed", error: { code: "license_required", message: "Pro plan needed" } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pro plan needed/i);
  });

  test("surfaces an API error as a real failure", async () => {
    global.fetch = (async () => new Response("design not found", { status: 404 })) as unknown as typeof fetch;
    const tool = createExportCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ designId: "nonexistent" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404/);
  });

  test("returns a failure result (not a throw) when nothing is linked", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const client = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const tool = createExportCanvaDesignTool(client);
    const result = await tool.execute({ designId: "D1" }, context);
    expect(result.success).toBe(false);
  });
});
