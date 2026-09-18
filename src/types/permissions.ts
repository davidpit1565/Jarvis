export const PermissionLevel = {
  READ: "READ",
  SAFE_ACTION: "SAFE_ACTION",
  CONFIRM: "CONFIRM",
  DANGEROUS: "DANGEROUS",
} as const;

export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

/**
 * Order matters: index reflects how much trust/impact a level implies.
 * Used to reason about escalation, not just equality checks.
 */
export const PERMISSION_LEVEL_ORDER: readonly PermissionLevel[] = [
  PermissionLevel.READ,
  PermissionLevel.SAFE_ACTION,
  PermissionLevel.CONFIRM,
  PermissionLevel.DANGEROUS,
];

export interface PermissionSubject {
  userId: string;
}

export interface PermissionCheckRequest {
  subject: PermissionSubject;
  toolId: string;
  requiredLevel: PermissionLevel;
  /**
   * The device the tool would run on, if any. Omitted (or undefined) for
   * tools that always run locally in Core. A grant scoped to one device
   * never applies to another — granting GET_ACTIVE_APPLICATION on the
   * iMac must not authorize it on a future MacBook.
   */
  deviceId?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  requiredLevel: PermissionLevel;
  /**
   * True when `allowed` is true but a per-invocation human confirmation is
   * still required before the tool may actually run (CONFIRM/DANGEROUS
   * tools with a standing grant). A standing grant alone is never enough
   * to run these — it only means the user has opted in to being asked.
   */
  requiresConfirmation: boolean;
}
