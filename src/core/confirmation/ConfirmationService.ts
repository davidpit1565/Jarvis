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

/**
 * Gatekeeper for CONFIRM/DANGEROUS tools. A standing PermissionService
 * grant only means the user has opted in to being asked — this is what
 * actually asks, every single time, before such a tool is allowed to run.
 */
export class ConfirmationService {
  constructor(private readonly prompter: ConfirmationPrompter) {}

  async requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
    return this.prompter(request);
  }
}
