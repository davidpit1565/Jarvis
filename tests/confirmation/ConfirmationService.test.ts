import { describe, test, expect } from "bun:test";
import { ConfirmationService } from "@/core/confirmation/ConfirmationService";
import { RateLimiter } from "@/communication/websocket/RateLimiter";

const REQUEST = { toolId: "T", toolName: "test_tool", userId: "user-1", input: {} };

describe("ConfirmationService", () => {
  test("resolves with the prompter's answer when it answers promptly", async () => {
    const service = new ConfirmationService(async () => true, 1000);
    expect(await service.requestConfirmation(REQUEST)).toBe(true);
  });

  test("resolves false when the prompter answers false", async () => {
    const service = new ConfirmationService(async () => false, 1000);
    expect(await service.requestConfirmation(REQUEST)).toBe(false);
  });

  test("times out to false when the prompter never answers", async () => {
    const service = new ConfirmationService(() => new Promise<boolean>(() => {}), 20);
    expect(await service.requestConfirmation(REQUEST)).toBe(false);
  });

  test("a slow-but-eventual answer after the timeout doesn't matter — the turn already resolved false", async () => {
    const service = new ConfirmationService(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
      20
    );
    expect(await service.requestConfirmation(REQUEST)).toBe(false);
  });

  test("a prompter that throws resolves false, not a rejected promise", async () => {
    const service = new ConfirmationService(async () => {
      throw new Error("prompter blew up");
    }, 1000);
    expect(await service.requestConfirmation(REQUEST)).toBe(false);
  });

  test("defaults to a real timeout when none is given", async () => {
    const service = new ConfirmationService(async () => true);
    expect(await service.requestConfirmation(REQUEST)).toBe(true);
  });

  test("denies immediately, without calling the prompter, once the per-tool-per-user rate limit is exceeded", async () => {
    let promptCalls = 0;
    const rateLimiter = new RateLimiter(2, 60_000);
    const service = new ConfirmationService(
      async () => {
        promptCalls++;
        return true;
      },
      1000,
      rateLimiter
    );

    expect(await service.requestConfirmation(REQUEST)).toBe(true);
    expect(await service.requestConfirmation(REQUEST)).toBe(true);
    expect(await service.requestConfirmation(REQUEST)).toBe(false);
    expect(promptCalls).toBe(2);
  });

  test("rate limits are scoped per tool+user, not shared globally", async () => {
    const rateLimiter = new RateLimiter(1, 60_000);
    const service = new ConfirmationService(async () => true, 1000, rateLimiter);

    expect(await service.requestConfirmation(REQUEST)).toBe(true);
    expect(await service.requestConfirmation({ ...REQUEST, userId: "user-2" })).toBe(true);
    expect(await service.requestConfirmation({ ...REQUEST, toolId: "OTHER_TOOL" })).toBe(true);
  });
});
