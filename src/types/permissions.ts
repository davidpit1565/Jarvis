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
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  requiredLevel: PermissionLevel;
}
