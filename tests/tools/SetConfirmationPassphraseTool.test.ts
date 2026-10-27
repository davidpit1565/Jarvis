import { describe, test, expect } from "bun:test";
import { ConfirmationPassphraseStore } from "@/security/ConfirmationPassphraseStore";
import { createSetConfirmationPassphraseTool } from "@/tools/security/SetConfirmationPassphraseTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };

describe("SET_CONFIRMATION_PASSPHRASE tool", () => {
  test("is CONFIRM", () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    const tool = createSetConfirmationPassphraseTool(store);
    expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
    store.close();
  });

  test("sets the passphrase", async () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    const tool = createSetConfirmationPassphraseTool(store);

    const result = await tool.execute({ passphrase: "open sesame" }, context);

    expect(result.success).toBe(true);
    expect(store.get()).toBe("open sesame");
    store.close();
  });

  test("trims surrounding whitespace before storing", async () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    const tool = createSetConfirmationPassphraseTool(store);

    await tool.execute({ passphrase: "  open sesame  " }, context);

    expect(store.get()).toBe("open sesame");
    store.close();
  });

  test("rejects a too-short passphrase", async () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    const tool = createSetConfirmationPassphraseTool(store);

    const result = await tool.execute({ passphrase: "ab" }, context);

    expect(result.success).toBe(false);
    expect(store.get()).toBeNull();
    store.close();
  });

  test("rejects a non-string passphrase", async () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    const tool = createSetConfirmationPassphraseTool(store);

    const result = await tool.execute({ passphrase: 12345 as unknown as string }, context);

    expect(result.success).toBe(false);
    store.close();
  });

  test("replaces a previously set passphrase", async () => {
    const store = new ConfirmationPassphraseStore(":memory:");
    store.set("old phrase");
    const tool = createSetConfirmationPassphraseTool(store);

    await tool.execute({ passphrase: "new phrase" }, context);

    expect(store.get()).toBe("new phrase");
    store.close();
  });
});
