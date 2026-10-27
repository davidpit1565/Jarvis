import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CanvaClient } from "@/canva/CanvaClient";

export interface ListCanvaDesignsInput extends Record<string, unknown> {
  /** Optional search term, e.g. "BFA presentation" — omit to list the user's most recently modified designs. */
  query?: string;
}

/**
 * Lets the user ask "show me my Canva" / "what designs do I have in
 * Canva" and get a real answer. READ-level: purely informational, no
 * side effects — same reasoning as GET_CURRENTLY_PLAYING.
 */
export function createListCanvaDesignsTool(canvaClient: CanvaClient): LocalTool<ListCanvaDesignsInput> {
  return {
    id: "LIST_CANVA_DESIGNS",
    name: "list_canva_designs",
    description:
      "Lists the user's own Canva designs (most recently modified first), optionally filtered by a search term. " +
      "Use this for \"show me my Canva\" / \"what have I designed in Canva\" / \"find my [X] design in Canva.\" " +
      "Requires a linked Canva account (see CREATE_CANVA_DESIGN for the account-linking requirement).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search term to filter designs by." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (input.query !== undefined && typeof input.query !== "string") {
        return { success: false, error: "query must be a string" };
      }

      try {
        const designs = await canvaClient.listDesigns(input.query);
        return { success: true, data: { designs, count: designs.length } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
