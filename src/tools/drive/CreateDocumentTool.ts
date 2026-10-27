import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleDocsClient, DocumentSection } from "@/drive/GoogleDocsClient";

export interface CreateDocumentInput extends Record<string, unknown> {
  title: string;
  sections: DocumentSection[];
  /** Which linked Google account to create the document on, by email. Omit to use whichever account was linked first. */
  account?: string;
}

function isValidSection(section: unknown): section is DocumentSection {
  if (typeof section !== "object" || section === null) return false;
  const s = section as Record<string, unknown>;
  if (s.heading !== undefined && typeof s.heading !== "string") return false;
  if (s.paragraphs !== undefined && (!Array.isArray(s.paragraphs) || s.paragraphs.some((p) => typeof p !== "string"))) return false;
  if (s.bullets !== undefined && (!Array.isArray(s.bullets) || s.bullets.some((b) => typeof b !== "string"))) return false;
  return true;
}

/**
 * Lets the user say "write me a real document/report about X" and get an
 * actual formatted Google Doc back — a title, headed sections, prose
 * paragraphs, and optional bullet lists within a section — rather than
 * CREATE_CHECKLIST's narrower flat checkbox list. See GoogleDocsClient's
 * own doc comment for the exact Docs API request shape this relies on.
 *
 * SAFE_ACTION, same reasoning as CREATE_CHECKLIST/CREATE_PRESENTATION: a
 * new Drive file is easily reversible and low risk.
 */
export function createCreateDocumentTool(docsClient: GoogleDocsClient): LocalTool<CreateDocumentInput> {
  return {
    id: "CREATE_DOCUMENT",
    name: "create_document",
    description:
      "Creates a new Google Doc in the user's Drive containing a REAL formatted document — not a plain " +
      "checklist (use CREATE_CHECKLIST for that) and not a slide deck (use CREATE_PRESENTATION for that). " +
      "Use this for a report, summary, memo, or any other written document the user asks JARVIS to prepare, " +
      "the way a capable assistant would write one: a title plus one or more sections, each with an optional " +
      "heading, optional prose paragraphs, and an optional bullet list. Mix multiple sections freely — e.g. " +
      "an 'Overview' section with paragraphs followed by a 'Next steps' section with bullets. Returns the " +
      "document's webViewLink so the user can open it. Requires a linked Google account (see " +
      "CREATE_CALENDAR_EVENT for the same account-linking requirement).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title." },
        sections: {
          type: "array",
          description:
            "The document's content, rendered in order. Each section is a block of content: an optional " +
            "heading (rendered as a real Docs heading style), optional paragraphs (plain prose text, one " +
            "entry per paragraph), and an optional bullet list (rendered as a real bulleted list). Include " +
            "whichever of heading/paragraphs/bullets fit — e.g. a section can be just paragraphs with no " +
            "heading, or just a heading plus bullets with no prose.",
          items: {
            type: "object",
            properties: {
              heading: { type: "string", description: "This section's heading text. Omit for an unheaded section." },
              paragraphs: {
                type: "array",
                items: { type: "string" },
                description: "Prose paragraphs for this section, in order. Omit if this section has no body prose.",
              },
              bullets: {
                type: "array",
                items: { type: "string" },
                description: "Bullet list items for this section, in order. Omit if this section has no bullet list.",
              },
            },
          },
        },
        account: {
          type: "string",
          description:
            "Which linked Google account to create the document on, by email. Omit to use whichever account was linked first.",
        },
      },
      required: ["title", "sections"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.title !== "string" || input.title.trim() === "") {
        return { success: false, error: "title must be a non-empty string" };
      }
      if (!Array.isArray(input.sections) || input.sections.length === 0 || !input.sections.every(isValidSection)) {
        return {
          success: false,
          error: "sections must be a non-empty array of { heading?: string, paragraphs?: string[], bullets?: string[] }",
        };
      }
      if (input.account !== undefined && typeof input.account !== "string") {
        return { success: false, error: "account must be a string" };
      }

      try {
        const { file, blockCount } = await docsClient.createDocument(input.title, input.sections, input.account);
        return { success: true, data: { file, blockCount } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
