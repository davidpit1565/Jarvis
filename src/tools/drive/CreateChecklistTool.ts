import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleDocsClient } from "@/drive/GoogleDocsClient";

export interface CreateChecklistInput extends Record<string, unknown> {
  title: string;
  items: string[];
  /** Which linked Google account to create the checklist on, by email. Omit to use whichever account was linked first. */
  account?: string;
}

/**
 * Lets the user say "make me a checklist/to-do list for X" and get a real
 * Google Doc in their Drive with an actual checkbox list (real checkbox
 * glyphs, not plain bullet points) — see GoogleDocsClient's own doc
 * comment for the exact Docs API request shape this relies on.
 *
 * SAFE_ACTION, same reasoning as CREATE_PRESENTATION/CREATE_CALENDAR_EVENT:
 * a new Drive file is easily reversible and low risk.
 */
export function createCreateChecklistTool(docsClient: GoogleDocsClient): LocalTool<CreateChecklistInput> {
  return {
    id: "CREATE_CHECKLIST",
    name: "create_checklist",
    description:
      "Creates a new Google Doc in the user's Drive containing a real checkbox checklist (not just plain " +
      "bullets), and returns its webViewLink so the user can open it. Use this for to-do lists, packing " +
      "lists, shopping lists, or any other checklist the user asks JARVIS to prepare. Requires a linked " +
      "Google account (see CREATE_CALENDAR_EVENT for the same account-linking requirement).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title." },
        items: {
          type: "array",
          items: { type: "string" },
          description: "The checklist items, in order.",
        },
        account: {
          type: "string",
          description:
            "Which linked Google account to create the checklist on, by email. Omit to use whichever account was linked first.",
        },
      },
      required: ["title", "items"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.title !== "string" || input.title.trim() === "") {
        return { success: false, error: "title must be a non-empty string" };
      }
      if (!Array.isArray(input.items) || input.items.some((item) => typeof item !== "string")) {
        return { success: false, error: "items must be an array of strings" };
      }
      if (input.items.length === 0) {
        return { success: false, error: "items must have at least one item" };
      }
      if (input.account !== undefined && typeof input.account !== "string") {
        return { success: false, error: "account must be a string" };
      }

      try {
        const { file, itemCount } = await docsClient.createChecklist(input.title, input.items, input.account);
        return { success: true, data: { file, itemCount } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
