import { describe, test, expect } from "bun:test";
import { PermissionService } from "@/permissions/PermissionService";
import { PermissionLevel } from "@/types/permissions";

describe("PermissionService", () => {
  test("allows READ-level tools by default", () => {
    const service = new PermissionService();
    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "READ_ONLY_FILE_INFO",
      requiredLevel: PermissionLevel.READ,
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  test("denies SAFE_ACTION tools without a grant", () => {
    const service = new PermissionService();
    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
    });

    expect(result.allowed).toBe(false);
  });

  test("allows SAFE_ACTION tools after an explicit grant", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
    });

    expect(result.allowed).toBe(true);
  });

  test("denies CONFIRM-level tools with no grant at all", () => {
    const service = new PermissionService();

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.CONFIRM,
    });

    expect(result.allowed).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
  });

  test("allows CONFIRM-level tools with a grant, but flags that confirmation is still required", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.CONFIRM,
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  test("allows DANGEROUS-level tools with a grant, but flags that confirmation is still required", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.DANGEROUS,
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  test("grants are per-user", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-2" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
    });

    expect(result.allowed).toBe(false);
  });

  test("a device-scoped grant allows the tool on that device", () => {
    const service = new PermissionService();
    service.grant("user-1", "GET_ACTIVE_APPLICATION", "imac-1");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "GET_ACTIVE_APPLICATION",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId: "imac-1",
    });

    expect(result.allowed).toBe(true);
  });

  test("a grant scoped to one device does not authorize the same tool on a different device", () => {
    const service = new PermissionService();
    service.grant("user-1", "GET_ACTIVE_APPLICATION", "imac-1");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "GET_ACTIVE_APPLICATION",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId: "macbook-1",
    });

    expect(result.allowed).toBe(false);
  });

  test("a local (no-device) grant does not authorize the same tool on a device", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL"); // no deviceId: local scope

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId: "imac-1",
    });

    expect(result.allowed).toBe(false);
  });

  test("revoke removes a device-scoped grant", () => {
    const service = new PermissionService();
    service.grant("user-1", "GET_ACTIVE_APPLICATION", "imac-1");
    service.revoke("user-1", "GET_ACTIVE_APPLICATION", "imac-1");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "GET_ACTIVE_APPLICATION",
      requiredLevel: PermissionLevel.SAFE_ACTION,
      deviceId: "imac-1",
    });

    expect(result.allowed).toBe(false);
  });

  test("READ-level tools are allowed regardless of device", () => {
    const service = new PermissionService();
    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "GET_ACTIVE_APPLICATION",
      requiredLevel: PermissionLevel.READ,
      deviceId: "imac-1",
    });

    expect(result.allowed).toBe(true);
  });

  test("list() returns every standing grant decoded back into userId/toolId/deviceId", () => {
    const service = new PermissionService();
    service.grant("user-1", "OPEN_URL", "imac-1");
    service.grant("user-1", "SAVE_MEMORY"); // no device — local scope

    const grants = service.list();

    expect(grants).toContainEqual({ userId: "user-1", toolId: "OPEN_URL", deviceId: "imac-1" });
    const localGrant = grants.find((g) => g.toolId === "SAVE_MEMORY");
    expect(localGrant).toBeDefined();
    expect(localGrant?.deviceId).toBeUndefined();
  });

  test("list() no longer includes a grant after it's revoked", () => {
    const service = new PermissionService();
    service.grant("user-1", "OPEN_URL", "imac-1");
    service.revoke("user-1", "OPEN_URL", "imac-1");

    expect(service.list()).toEqual([]);
  });

  test("list() is empty with no grants at all", () => {
    expect(new PermissionService().list()).toEqual([]);
  });
});
