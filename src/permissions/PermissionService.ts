import {
  PERMISSION_LEVEL_ORDER,
  type PermissionCheckRequest,
  type PermissionCheckResult,
} from "@/types/permissions";

const LOCAL_SCOPE = "__local__";

function grantKey(userId: string, toolId: string, deviceId: string | undefined): string {
  return `${userId}::${toolId}::${deviceId ?? LOCAL_SCOPE}`;
}

/**
 * Per-user, per-tool, per-device grants. Phase 2 keeps this in-memory —
 * future phases can back it with a real store without changing the public
 * interface. A grant is scoped to exactly one device (or "local" for
 * tools with no device): granting a tool on one device never authorizes
 * the same tool on a different device.
 */
export type GrantStore = Set<string>;

export class PermissionService {
  constructor(private readonly grants: GrantStore = new Set()) {}

  /**
   * Grants a user standing access to a tool. `deviceId` scopes the grant
   * to a specific device; omit it for tools that run locally in Core.
   * For CONFIRM/DANGEROUS tools, a grant means "the user has opted in to
   * being asked" — it does not skip the per-invocation confirmation.
   */
  grant(userId: string, toolId: string, deviceId?: string): void {
    this.grants.add(grantKey(userId, toolId, deviceId));
  }

  revoke(userId: string, toolId: string, deviceId?: string): void {
    this.grants.delete(grantKey(userId, toolId, deviceId));
  }

  /**
   * Every standing grant currently held, decoded back into its parts —
   * for a read-only admin UI (Permission Management UI,
   * JARVIS_ROADMAP_AUDIT.md #205) to show which tools are granted to
   * which devices. `deviceId` is `undefined` for a grant with no device
   * scope (the local-only sentinel used internally is never leaked out).
   */
  list(): Array<{ userId: string; toolId: string; deviceId?: string }> {
    return Array.from(this.grants).map((key) => {
      const [userId, toolId, deviceId] = key.split("::");
      return {
        userId: userId!,
        toolId: toolId!,
        deviceId: deviceId === LOCAL_SCOPE ? undefined : deviceId,
      };
    });
  }

  check(request: PermissionCheckRequest): PermissionCheckResult {
    const { subject, toolId, requiredLevel, deviceId } = request;

    if (!PERMISSION_LEVEL_ORDER.includes(requiredLevel)) {
      return {
        allowed: false,
        reason: `Unknown permission level: ${requiredLevel}`,
        requiredLevel,
        requiresConfirmation: false,
      };
    }

    // READ-level tools are allowed by default: they cannot mutate state,
    // so requiring an explicit grant would add friction without a
    // security benefit. This still applies per-device implicitly (a READ
    // tool is READ regardless of target device).
    if (requiredLevel === "READ") {
      return {
        allowed: true,
        reason: "READ-level tools are allowed by default",
        requiredLevel,
        requiresConfirmation: false,
      };
    }

    const hasGrant = this.grants.has(grantKey(subject.userId, toolId, deviceId));

    if (!hasGrant) {
      const scope = deviceId ? `tool "${toolId}" on device "${deviceId}"` : `tool "${toolId}"`;
      return {
        allowed: false,
        reason: `User has no grant for ${scope} at level ${requiredLevel}`,
        requiredLevel,
        requiresConfirmation: false,
      };
    }

    // CONFIRM/DANGEROUS: a grant permits the tool to be asked about, but
    // the caller (Orchestrator) must still obtain a fresh confirmation
    // for every single invocation before it may run.
    if (requiredLevel === "CONFIRM" || requiredLevel === "DANGEROUS") {
      return {
        allowed: true,
        reason: "Grant present; per-invocation confirmation still required",
        requiredLevel,
        requiresConfirmation: true,
      };
    }

    return { allowed: true, reason: "Explicit grant present", requiredLevel, requiresConfirmation: false };
  }
}
