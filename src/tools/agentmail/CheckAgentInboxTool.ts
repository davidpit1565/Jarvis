import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { AgentMailClient } from "@/agentmail/AgentMailClient";

export interface CheckAgentInboxInput extends Record<string, unknown> {
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;

/**
 * Lists the most recent messages in JARVIS's OWN independent AgentMail
 * inbox — NOT the user's personal Gmail (see SEARCH_EMAIL/GET_EMAIL for
 * that). READ-only: no send, delete, or modify. Bounded the same way
 * SEARCH_EMAIL and MemoryStore.search are — a caller can never pull an
 * unbounded number of messages in one call, regardless of what
 * maxResults it asks for.
 */
export function createCheckAgentInboxTool(agentMailClient: AgentMailClient): LocalTool<CheckAgentInboxInput> {
  return {
    id: "CHECK_AGENT_INBOX",
    name: "check_agent_inbox",
    description:
      "Lists the most recent messages received in JARVIS's own AgentMail inbox (its own separate email identity, " +
      "not the user's personal Gmail). Returns each message's sender, subject, and a short preview. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        maxResults: {
          type: "number",
          description: `Maximum number of messages to return. Defaults to ${DEFAULT_MAX_RESULTS}, capped at ${MAX_RESULTS_CAP}.`,
        },
      },
      required: [],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const messages = await agentMailClient.listMessages(maxResults ?? DEFAULT_MAX_RESULTS);
        return { success: true, data: { messages } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
