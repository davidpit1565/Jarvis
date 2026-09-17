import {
  PERMISSION_LEVEL_ORDER,
  type PermissionCheckRequest,
  type PermissionCheckResult,
} from "@/types/permissions";

/**
 * Per-user grants, keyed by userId then toolId. Phase 1 has no real auth or
 * persistence for this yet — future phases can back this with a real store
 * without changing the public interface.
 */
export type GrantStore = Map<string, Set<string>>;

export class PermissionService {
  constructor(private readonly grants: GrantStore = new Map()) {}

  /** Grants a user standing access to a specific tool. */
  grant(userId: string, toolId: string): void {
    const userGrants = this.grants.get(userId) ?? new Set();
    userGrants.add(toolId);
    this.grants.set(userId, userGrants);
  }

  check(request: PermissionCheckRequest): PermissionCheckResult {
    const { subject, toolId, requiredLevel } = request;

    if (!PERMISSION_LEVEL_ORDER.includes(requiredLevel)) {
      return { allowed: false, reason: `Unknown permission level: ${requiredLevel}`, requiredLevel };
    }

    // READ-level tools are allowed by default in Phase 1: they cannot
    // mutate state, so requiring an explicit grant would add friction
    // without a security benefit.
    if (requiredLevel === "READ") {
      return { allowed: true, reason: "READ-level tools are allowed by default", requiredLevel };
    }

    const userGrants = this.grants.get(subject.userId);
    const hasGrant = userGrants?.has(toolId) ?? false;

    if (!hasGrant) {
      return {
        allowed: false,
        reason: `User has no grant for tool "${toolId}" at level ${requiredLevel}`,
        requiredLevel,
      };
    }

    // SAFE_ACTION is grantable outright. CONFIRM/DANGEROUS additionally
    // require an explicit confirmation step, which Phase 1 does not
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
