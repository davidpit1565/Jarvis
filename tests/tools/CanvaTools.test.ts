import { describe, test, expect, afterEach } from "bun:test";
import { CanvaTokenStore } from "@/canva/CanvaTokenStore";
import { CanvaClient } from "@/canva/CanvaClient";
import { createListCanvaDesignsTool } from "@/tools/canva/ListCanvaDesignsTool";
import { createListCanvaBrandTemplatesTool } from "@/tools/canva/ListCanvaBrandTemplatesTool";
import { createCreateCanvaDesignTool } from "@/tools/canva/CreateCanvaDesignTool";
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

describe("LIST_CANVA_DESIGNS tool", () => {
  test("is READ", () => {
    const tool = createListCanvaDesignsTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the user's designs", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "D1",
              title: "BFA Deck",
              urls: { edit_url: "https://canva.com/edit", view_url: "https://canva.com/view" },
              updated_at: 1700000000,
              design_types: ["presentation"],
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createListCanvaDesignsTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { count: number }).count).toBe(1);
  });

  test("rejects a non-string query", async () => {
    const tool = createListCanvaDesignsTool(makeLinkedClient());
    const result = await tool.execute({ query: 42 as unknown as string }, context);
    expect(result.success).toBe(false);
  });

  test("returns a failure result (not a throw) when nothing is linked", async () => {
    const tokenStore = new CanvaTokenStore(":memory:");
    const client = new CanvaClient("id", "secret", "https://example.com/canva/oauth/callback", tokenStore);
    const tool = createListCanvaDesignsTool(client);
    const result = await tool.execute({}, context);
    expect(result.success).toBe(false);
  });
});

describe("LIST_CANVA_BRAND_TEMPLATES tool", () => {
  test("is READ", () => {
    const tool = createListCanvaBrandTemplatesTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the user's brand templates", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [{ id: "BT1", title: "BFA Report", view_url: "https://canva.com/view", create_url: "https://canva.com/create" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createListCanvaBrandTemplatesTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { count: number }).count).toBe(1);
  });

  test("an empty result is still a success (no templates set up yet is not an error)", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const tool = createListCanvaBrandTemplatesTool(makeLinkedClient());
    const result = await tool.execute({}, context);
    expect(result.success).toBe(true);
    expect((result.data as { count: number }).count).toBe(0);
  });
});

describe("CREATE_CANVA_DESIGN tool", () => {
  test("is CONFIRM", () => {
    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
  });

  test("creates a design from a brand template and text fields", async () => {
    global.fetch = (async (url: string) => {
      if (url.endsWith("/autofills")) {
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          job: {
            id: "job-1",
            status: "success",
            result: {
              type: "create_design",
              design: {
                id: "D1",
                title: "Checklist",
                urls: { edit_url: "https://canva.com/edit", view_url: "https://canva.com/view" },
              },
            },
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "BT1", fields: { headline: "Pack for trip" } }, context);
    expect(result.success).toBe(true);
    expect((result.data as { design: { id: string } }).design.id).toBe("D1");
  });

  test("rejects a missing brandTemplateId", async () => {
    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "", fields: { a: "b" } }, context);
    expect(result.success).toBe(false);
  });

  test("rejects empty fields", async () => {
    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "BT1", fields: {} }, context);
    expect(result.success).toBe(false);
  });

  test("rejects fields with a non-string value", async () => {
    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "BT1", fields: { a: 1 as unknown as string } }, context);
    expect(result.success).toBe(false);
  });

  test("surfaces a failed autofill job as a real failure, not fabricated success", async () => {
    global.fetch = (async (url: string) => {
      if (url.endsWith("/autofills")) {
        return new Response(JSON.stringify({ job: { id: "job-1", status: "in_progress" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ job: { id: "job-1", status: "failed", error: { code: "autofill_error", message: "bad template" } } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "BT1", fields: { a: "b" } }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bad template/i);
  });

  test("surfaces an API error (e.g. Free-plan autofill rejection) as a real failure", async () => {
    global.fetch = (async () => new Response("plan upgrade required", { status: 403 })) as unknown as typeof fetch;
    const tool = createCreateCanvaDesignTool(makeLinkedClient());
    const result = await tool.execute({ brandTemplateId: "BT1", fields: { a: "b" } }, context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403/);
  });
});
