import { describe, test, expect } from "bun:test";
import { toolRequiresVerification } from "@/tools/verificationPolicy";
import { PermissionLevel } from "@/types/permissions";

describe("toolRequiresVerification", () => {
  test("defaults READ tools to not requiring verification", () => {
    expect(toolRequiresVerification({ requiredPermission: PermissionLevel.READ })).toBe(false);
  });

  test("defaults SAFE_ACTION/CONFIRM/DANGEROUS tools to requiring verification", () => {
    expect(toolRequiresVerification({ requiredPermission: PermissionLevel.SAFE_ACTION })).toBe(true);
    expect(toolRequiresVerification({ requiredPermission: PermissionLevel.CONFIRM })).toBe(true);
    expect(toolRequiresVerification({ requiredPermission: PermissionLevel.DANGEROUS })).toBe(true);
  });

  test("an explicit requiresVerification overrides the permission-level default in both directions", () => {
    expect(toolRequiresVerification({ requiredPermission: PermissionLevel.READ, requiresVerification: true })).toBe(true);
    expect(
      toolRequiresVerification({ requiredPermission: PermissionLevel.DANGEROUS, requiresVerification: false })
    ).toBe(false);
  });
});
