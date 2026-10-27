import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { CanvaClient } from "@/canva/CanvaClient";

export interface CreateCanvaDesignInput extends Record<string, unknown> {
  /** The brand template's id — get this from LIST_CANVA_BRAND_TEMPLATES first. */
  brandTemplateId: string;
  /** Data field name -> text to autofill, matching the field names David tagged on the template in the Canva UI. */
  fields: Record<string, string>;
}

function isValidFields(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/**
 * Autofills a new Canva design from an existing Brand Template with text
 * data — the realistic v1 "generate a design/presentation/checklist in
 * Canva" path (see CanvaClient's own doc comment on why free-form Design
 * API generation isn't offered). Requires David to have already published
 * a Brand Template with tagged data fields in the Canva UI; use
 * LIST_CANVA_BRAND_TEMPLATES first to find its id, and match `fields`
 * keys to that template's actual field names.
 *
 * CONFIRM, unlike CREATE_PRESENTATION/CREATE_CHECKLIST's SAFE_ACTION:
 * per this PR's explicit instructions, a real, visible change to David's
 * own Canva account (a new design saved to his Projects) warrants a
 * fresh per-invocation confirmation rather than running silently.
 */
export function createCreateCanvaDesignTool(canvaClient: CanvaClient): LocalTool<CreateCanvaDesignInput> {
  return {
    id: "CREATE_CANVA_DESIGN",
    name: "create_canva_design",
    description:
      "Creates a new Canva design by autofilling an existing Brand Template with text data, and returns a link " +
      "to open it. Call LIST_CANVA_BRAND_TEMPLATES first to find the brandTemplateId and learn what data fields " +
      "that template expects (David tags these himself in the Canva UI when he sets up the template) — this tool " +
      "cannot design something from scratch, only fill in a template that already exists. Requires a linked " +
      "Canva account.",
    inputSchema: {
      type: "object",
      properties: {
        brandTemplateId: { type: "string", description: "The brand template's id, from LIST_CANVA_BRAND_TEMPLATES." },
        fields: {
          type: "object",
          description: "Data field name -> text value to autofill, matching the template's tagged field names.",
        },
      },
      required: ["brandTemplateId", "fields"],
    },
    requiredPermission: PermissionLevel.CONFIRM,
    target: "local",

    async execute(input) {
      if (typeof input.brandTemplateId !== "string" || input.brandTemplateId.trim() === "") {
        return { success: false, error: "brandTemplateId must be a non-empty string" };
      }
      if (!isValidFields(input.fields)) {
        return { success: false, error: "fields must be an object mapping field names to string values" };
      }
      if (Object.keys(input.fields).length === 0) {
        return { success: false, error: "fields must have at least one entry" };
      }

      try {
        const design = await canvaClient.createDesignFromBrandTemplate(input.brandTemplateId, input.fields);
        return { success: true, data: { design } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
