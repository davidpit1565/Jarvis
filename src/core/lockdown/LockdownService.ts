export interface LockdownStatus {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
}

/**
 * A break-glass kill switch: when active, every tool above READ
 * (SAFE_ACTION/CONFIRM/DANGEROUS — anything that writes, sends, calls, or
 * touches a device) is refused before it ever reaches a permission check
 * or a confirmation prompt. READ tools keep working, so JARVIS can still
 * answer questions while locked down, it just can't act.
 *
 * In-memory only, like PermissionService's grants — resets on restart,
 * which is the right default for an emergency measure meant to be lifted
 * deliberately, not something that should survive a crash-loop as a
 * permanent, forgotten lockdown.
 */
export class LockdownService {
  private active: boolean = false;
  private reason: string | null = null;
  private activatedAt: string | null = null;

  activate(reason?: string): void {
    this.active = true;
    this.reason = reason ?? null;
    this.activatedAt = new Date().toISOString();
  }

  deactivate(): void {
    this.active = false;
    this.reason = null;
    this.activatedAt = null;
  }

  isActive(): boolean {
    return this.active;
  }

  status(): LockdownStatus {
    return { active: this.active, reason: this.reason, activatedAt: this.activatedAt };
  }
}
