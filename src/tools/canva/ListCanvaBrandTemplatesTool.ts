import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CanvaClient } from "@/canva/CanvaClient";

export interface ListCanvaBrandTemplatesInput extends Record<string, unknown> {
  /** Optional search term — omit to list every brand template the user has access to. */
  query?: string;
}

/**
 * Lists the Brand Templates the user has set up in Canva — the only
 * realistic source CREATE_CANVA_DESIGN can autofill from (see
 * CanvaClient's own doc comment on why free-form generation isn't
 * offered). Use this first to find a brand_template_id before calling
 * CREATE_CANVA_DESIGN; an empty result means the user hasn't published
 * any Brand Template yet and needs to do that once in the Canva UI.
 * READ-level: purely informational, no side effects.
 */
export function createListCanvaBrandTemplatesTool(canvaClient: CanvaClient): LocalTool<ListCanvaBrandTemplatesInput> {
  return {
    id: "LIST_CANVA_BRAND_TEMPLATES",
    name: "list_canva_brand_templates",
    description:
      "Lists the Canva Brand Templates the user has published and has access to, each with an id and title. " +
      "Call this before CREATE_CANVA_DESIGN to find the brand_template_id to autofill. If this comes back empty, " +
      "the user hasn't published a Brand Template in Canva yet — tell them to do that once in the Canva UI before " +
      "JARVIS can generate a design for them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search term to filter brand templates by." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (input.query !== undefined && typeof input.query !== "string") {
        return { success: false, error: "query must be a string" };
      }

      try {
        const templates = await canvaClient.listBrandTemplates(input.query);
        return { success: true, data: { templates, count: templates.length } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
