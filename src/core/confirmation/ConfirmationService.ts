export interface ConfirmationRequest {
  toolId: string;
  toolName: string;
  userId: string;
  deviceId?: string;
  input: Record<string, unknown>;
}

/**
 * Presents a confirmation request to a human and resolves with their
 * decision. Deliberately just a function type, not tied to any specific
 * UI — today it's the interactive terminal chat loop; later it could be a
 * push notification, a phone call, or anything else that can answer
 * yes/no.
 */
export type ConfirmationPrompter = (request: ConfirmationRequest) => Promise<boolean>;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Gatekeeper for CONFIRM/DANGEROUS tools. A standing PermissionService
 * grant only means the user has opted in to being asked — this is what
 * actually asks, every single time, before such a tool is allowed to run.
 *
 * Bounded by a timeout that defaults to deny: without this, a prompter
 * with nobody to actually answer it (the CLI's `confirmViaChat` sitting on
 * `readline.question()` while everyone using JARVIS right now is on a
 * phone call, not at the terminal) would hang the whole conversation turn
 * forever. A silent, indefinite hang is worse than a denial the user can
 * just ask again for — so an unanswered confirmation times out to "no".
 */
export class ConfirmationService {
  constructor(
    private readonly prompter: ConfirmationPrompter,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  async requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, this.timeoutMs);

      this.prompter(request)
        .then((answer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(answer);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        });
    });
  }
}
