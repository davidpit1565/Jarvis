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
   */
  grant(userId: string, toolId: string, deviceId?: string): void {
    this.grants.add(grantKey(userId, toolId, deviceId));
  }

  revoke(userId: string, toolId: string, deviceId?: string): void {
    this.grants.delete(grantKey(userId, toolId, deviceId));
  }

  check(request: PermissionCheckRequest): PermissionCheckResult {
    const { subject, toolId, requiredLevel, deviceId } = request;

    if (!PERMISSION_LEVEL_ORDER.includes(requiredLevel)) {
      return { allowed: false, reason: `Unknown permission level: ${requiredLevel}`, requiredLevel };
    }

    // READ-level tools are allowed by default in Phase 1/2: they cannot
    // mutate state, so requiring an explicit grant would add friction
    // without a security benefit. This still applies per-device implicitly
    // (a READ tool is READ regardless of target device).
    if (requiredLevel === "READ") {
      return { allowed: true, reason: "READ-level tools are allowed by default", requiredLevel };
    }

    const hasGrant = this.grants.has(grantKey(subject.userId, toolId, deviceId));

    if (!hasGrant) {
      const scope = deviceId ? `tool "${toolId}" on device "${deviceId}"` : `tool "${toolId}"`;
      return {
        allowed: false,
        reason: `User has no grant for ${scope} at level ${requiredLevel}`,
        requiredLevel,
      };
    }

    // SAFE_ACTION is grantable outright. CONFIRM/DANGEROUS additionally
    // require an explicit confirmation step, which Phase 1/2 does not
    // implement — so they are denied even with a grant until that exists.
    if (requiredLevel === "CONFIRM" || requiredLevel === "DANGEROUS") {
      return {
        allowed: false,
        reason: `Permission level ${requiredLevel} requires a confirmation flow not yet implemented`,
        requiredLevel,
      };
    }

    return { allowed: true, reason: "Explicit grant present", requiredLevel };
  }
}
