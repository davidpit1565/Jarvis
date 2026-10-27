import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleSlidesClient } from "@/drive/GoogleSlidesClient";
import type { PresentationOutline } from "@/types/drive";

export interface CreatePresentationInput extends Record<string, unknown> {
  title: string;
  slides: Array<{ title: string; bullets: string[] }>;
  /** Which linked Google account to create the presentation on, by email. Omit to use whichever account was linked first. */
  account?: string;
}

function isValidOutline(value: unknown): value is Array<{ title: string; bullets: string[] }> {
  return (
    Array.isArray(value) &&
    value.every(
      (slide) =>
        typeof slide === "object" &&
        slide !== null &&
        typeof (slide as { title?: unknown }).title === "string" &&
        Array.isArray((slide as { bullets?: unknown }).bullets) &&
        (slide as { bullets: unknown[] }).bullets.every((b) => typeof b === "string")
    )
  );
}

/**
 * Lets the user say "prepare a presentation about X" and get a real Google
 * Slides deck in their Drive, not just a text outline in chat. The model
 * only ever produces this simple `{title, slides: [{title, bullets}]}`
 * shape — GoogleSlidesClient is the deterministic templating layer that
 * turns it into actual Slides API batchUpdate requests, so the model never
 * has to write raw Slides API JSON (which it would reliably get at least
 * partly wrong).
 *
 * SAFE_ACTION, matching CREATE_CALENDAR_EVENT: creating a file in the
 * user's own Drive is easily reversible (delete it/move to trash) and low
 * risk — nothing is sent anywhere, shared, or destructive to existing
 * data, so requiring an interactive confirmation for every single
 * presentation would defeat the point of just asking JARVIS to make one.
 */
export function createCreatePresentationTool(slidesClient: GoogleSlidesClient): LocalTool<CreatePresentationInput> {
  return {
    id: "CREATE_PRESENTATION",
    name: "create_presentation",
    description:
      "Creates a new Google Slides presentation in the user's Drive from a simple outline, and returns its " +
      "webViewLink so the user can open it. Write the outline yourself — a title, and a list of slides each " +
      "with its own title and a short list of bullet points — you do NOT need to know anything about the " +
      "Slides API; this tool turns the outline into real slides automatically. Keep bullets short (they're " +
      "slide bullets, not paragraphs). Requires a linked Google account (see CREATE_CALENDAR_EVENT for the " +
      "same account-linking requirement).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The presentation's title (also becomes its title slide)." },
        slides: {
          type: "array",
          description: "The content slides, in order. Each needs its own title and a short list of bullet points.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
            },
            required: ["title", "bullets"],
          },
        },
        account: {
          type: "string",
          description:
            "Which linked Google account to create the presentation on, by email. Omit to use whichever account was linked first.",
        },
      },
      required: ["title", "slides"],
    },
    requiredPermission: PermissionLevel.SAFE_ACTION,
    target: "local",

    async execute(input) {
      if (typeof input.title !== "string" || input.title.trim() === "") {
        return { success: false, error: "title must be a non-empty string" };
      }
      if (!isValidOutline(input.slides)) {
        return { success: false, error: "slides must be an array of {title: string, bullets: string[]}" };
      }
      if (input.slides.length === 0) {
        return { success: false, error: "slides must have at least one slide" };
      }
      if (input.account !== undefined && typeof input.account !== "string") {
        return { success: false, error: "account must be a string" };
      }

      const outline: PresentationOutline = { title: input.title, slides: input.slides };

      try {
        const { file, slideCount } = await slidesClient.createPresentation(outline, input.account);
        return { success: true, data: { file, slideCount } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
