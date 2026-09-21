import type { Tool } from "@/types/tools";
import { PermissionLevel } from "@/types/permissions";

/**
 * Whether a tool's successful result needs a follow-up verification step
 * before an autonomous agent task treats that step as actually done.
 *
 * This is driven entirely by tool metadata (`Tool.requiresVerification`),
 * never a hardcoded list of tool names: a tool opts out explicitly if it
 * wants to, and everything else gets the safe default — any tool whose
 * `requiredPermission` is above READ mutates state (create/update/delete)
 * and is assumed to need a real check that the mutation actually happened;
 * a READ tool can't mutate anything, so there's nothing to verify.
 */
export function toolRequiresVerification(tool: Pick<Tool, "requiredPermission" | "requiresVerification">): boolean {
  if (typeof tool.requiresVerification === "boolean") {
    return tool.requiresVerification;
  }
  return tool.requiredPermission !== PermissionLevel.READ;
}
