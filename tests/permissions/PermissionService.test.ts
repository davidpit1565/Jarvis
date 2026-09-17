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

  test("denies CONFIRM-level tools even with a grant (no confirmation flow yet)", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.CONFIRM,
    });

    expect(result.allowed).toBe(false);
  });

  test("denies DANGEROUS-level tools even with a grant", () => {
    const service = new PermissionService();
    service.grant("user-1", "SOME_TOOL");

    const result = service.check({
      subject: { userId: "user-1" },
      toolId: "SOME_TOOL",
      requiredLevel: PermissionLevel.DANGEROUS,
    });

    expect(result.allowed).toBe(false);
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
});
